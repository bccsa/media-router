import { muxInputBasePid, muxRouteMedia } from './muxPids.js';
import {
    DEFAULT_MPEGTS_ALIGNMENT,
    GstPluginBase,
    ThroughputPoller,
    busTeeName,
    capsStreamInfo,
    type PipelineDescription,
    type ModuleServices,
    type StreamCapsInfo,
    type ThroughputSample,
} from '@media-router/engine';
import {
    buildDynamicPorts,
    buildPipeline,
    configPidConflicts,
    effectiveInputPid,
    inputEntries,
    isInputPort,
    isLegacyConfig,
    MuxerPidConflictError,
    sortSources,
    type DynamicPort,
    type InputEntry,
    type MuxedStreamSlot,
    type UdpInputSource,
} from './mpegtsMuxerPipeline.js';

/**
 * MPEG-TS Muxer plugin.
 *
 * Combines several muxed/mpegts bus streams into one. Each connected input
 * port is demuxed back to its elementary streams and every stream — video,
 * audio, KLV (WebVTT subtitles), DVB/teletext subtitles — is re-muxed into a
 * single transport stream on a deterministic PID, then published on the bus
 * channel assigned by MediaRouter. Inputs are media-agnostic: see the header
 * of mpegtsMuxerPipeline.ts for the routing/PID contract and how configs from
 * before generic inputs keep their ports and PIDs.
 */
export class MpegTsMuxerModule extends GstPluginBase {
    // The input arrays (generic and legacy) are live for renames only: a name is a UI label on the
    // input pin and never reaches the wire, so it applies without a rebuild;
    // adding/removing an entry changes the port set and routes through the
    // pending-restart path via `isLiveChange` below.
    protected liveUpdatableParams: string[] = ['inputs', 'videoStreams', 'audioStreams'];

    /** Output-bitrate poller on the bus egress. */
    private readonly throughput = new ThroughputPoller({
        getBytes: () => this.readSinkBytes(),
        publish: (sample) => this.publishThroughput(sample),
    });
    /** Bus egress element to poll for throughput, resolved at build time: the
     *  fan-out `tee` (busTeeName). */
    private busSinkName: string | undefined;

    // Routed-stream bookkeeping for the status panel, rebuilt on every
    // pipeline build. `slots` joins `stream:discovered` events (demux element
    // + the pad's route class) back to output PIDs; `discovered` holds the
    // first caps seen per output PID (the first pad of a class is the one the
    // rule routed).
    private slots: MuxedStreamSlot[] = [];
    private discovered = new Map<number, StreamCapsInfo>();
    private connectedInputs = 0;
    private legacyNoted = false;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** Generate one input port per configured input + a single output port. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(inputEntries(config));
    }

    /** Input-array edits are live only when the length is unchanged (rename)
     *  AND no entry's `offsetMs`, `language` or PID override changed. A
     *  grown/shrunk array means a different port set; an offset or PID change
     *  alters the pad-link routes and a language change alters the branch's
     *  `taginject` — all applied at build time, so treating them as live
     *  would silently swallow the edit. All route through pending-restart. */
    isLiveChange(key: string, newValue: unknown, oldValue: unknown): boolean {
        if (!['inputs', 'videoStreams', 'audioStreams'].includes(key)) return true;
        if (
            !Array.isArray(newValue) ||
            !Array.isArray(oldValue) ||
            newValue.length !== oldValue.length
        ) {
            return false;
        }
        return newValue.every((e, i) => {
            const entry = (e ?? {}) as Record<string, unknown>;
            const prev = (oldValue[i] ?? {}) as Record<string, unknown>;
            // The module's own seed — the automatic PID written back into a
            // blank field (see seedAssignedPids) — changes nothing on the wire
            // and must not bounce the muxer through a restart.
            const pidUnchanged =
                (entry.pid ?? 0) === (prev.pid ?? 0) ||
                ((prev.pid ?? 0) === 0 && entry.pid === muxInputBasePid(i));
            return (
                (entry.offsetMs ?? 0) === (prev.offsetMs ?? 0) &&
                (entry.language ?? '') === (prev.language ?? '') &&
                pidUnchanged
            );
        });
    }

    async onStart(): Promise<void> {
        await super.onStart();
        // Poll the egress bytes-served every 2s. The poller's counter-reset
        // guard turns the counter resetting to 0 on a child re-spawn
        // (restartOnError) into a fresh baseline instead of a negative rate.
        this.throughput.start();
    }

    private async readSinkBytes(): Promise<number | undefined> {
        return this.busSinkName ? this.readBusSinkBytes(this.busSinkName) : undefined;
    }

    private publishThroughput(sample: ThroughputSample): void {
        this.setStatusData('throughput', {
            'Output Bitrate': `${sample.bitrateKbps} kbps`,
            'Total Bytes': `${(sample.totalBytes / 1024 / 1024).toFixed(1)} MB`,
        });
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const entries = inputEntries(config);
        const legacy = isLegacyConfig(config);
        // Operator PIDs are checked over EVERY configured input, wired or not,
        // so a clash surfaces as soon as it is set (see configPidConflicts).
        // The wired layout is re-checked in buildPipeline.
        const pidConflicts = configPidConflicts(entries);
        if (pidConflicts.length > 0) {
            this.setHealth('error', `PID conflict — ${pidConflicts.join('; ')}`);
            return null;
        }
        if (!legacy) this.seedAssignedPids(config, entries);
        if (legacy && !this.legacyNoted) {
            this.legacyNoted = true;
            this.log.info(
                'Legacy video/audio input ports in use — ids and PIDs preserved; ' +
                    're-create the module to switch to generic inputs',
            );
        }

        const allSources = router.getModuleBusSources(instanceId);
        const muxedSources: UdpInputSource[] = allSources
            .filter((s) => isInputPort(s.sinkPortId))
            .map((s) => {
                const entry = entryForPort(entries, s.sinkPortId);
                return {
                    sinkPortId: s.sinkPortId,
                    port: s.port,
                    socketPath: s.socketPath,
                    offsetMs: entry?.offsetMs,
                    language: entry?.language,
                    ...(entry?.pid !== undefined ? { pid: entry.pid } : {}),
                };
            });
        const sources = sortSources(muxedSources);

        // Parser selection is done by the Python pad-link runner from each
        // pad's caps at pad-added time — unsupported codecs surface as a
        // runner-emitted warning, not as a pre-flight pipeline refusal.

        if (sources.length === 0) {
            this.setHealth('warning', 'No inputs connected — connect at least one source');
            return null;
        }

        const endpoint = router.assignBusChannel(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free UDP ports available');
            return null;
        }
        this.busSinkName = busTeeName(endpoint.port);

        const alignment = (config.alignment as number) ?? DEFAULT_MPEGTS_ALIGNMENT;
        // Stability-vs-latency is a per-use-case operator call, not a
        // constant — see the queueLeaky doc in the pipeline helpers.
        const queueLeaky = (config.queueLeaky as boolean) ?? false;
        const queueDepthMs = config.queueDepthMs as number | undefined;
        let result;
        try {
            result = buildPipeline({
                sources,
                output: endpoint,
                alignment,
                queueLeaky,
                queueDepthMs,
                videoParserBypass: config.videoParserBypass === true,
            });
        } catch (err) {
            if (!(err instanceof MuxerPidConflictError)) throw err;
            this.setHealth('error', err.message);
            return null;
        }
        if (!result) return null;

        // Discovery is per-pipeline (a rebuild re-fires every pad-added), so
        // stale entries must not leak across builds.
        this.slots = result.slots;
        this.discovered.clear();
        this.connectedInputs = sources.length;

        this.setStatusData('bus', { channel: endpoint.port });
        this.publishInputStatus(legacy);

        return {
            pipeline: result.pipeline,
            runnerHooks: result.runnerHooks,
            restartOnError: true,
            // Anchor every input branch to its producer's house stamps, so the
            // branches' private zero points stop showing up as A/V skew at the
            // mux output (and stop being re-rolled on every restart). Dropped by
            // `applyTimeSync` when the time-sync contract is off.
            alignBranchesToStamps: { demuxes: result.demuxes },
            // Dark-input detection (see INPUT_STALL_TIMEOUT_MS): runner-side,
            // one entry per input source, no `watchdog` element in the branch.
            inputStallWatch: result.inputStallWatch,
        };
    }

    /**
     * Write the automatic base PID into every blank `inputs[i].pid` so the
     * settings field shows the PID actually in use instead of 0 (the operator
     * asked for exactly that, 2026-09-16). Goes through `emitConfigUpdate` →
     * manager persist, like the splitter's discovered streams; the value is
     * what the layout would have chosen anyway, and `isLiveChange` recognises
     * the seed so the echoed patch never restarts the muxer. Once written the
     * PID is explicit: adding inputs later never moves it.
     */
    private seedAssignedPids(config: Record<string, unknown>, entries: InputEntry[]): void {
        const raw = Array.isArray(config.inputs) ? (config.inputs as unknown[]) : [{}];
        let changed = false;
        const inputs = raw.slice(0, entries.length).map((item, i) => {
            if (entries[i].pid !== undefined) return item;
            changed = true;
            return {
                ...((item ?? {}) as Record<string, unknown>),
                pid: effectiveInputPid(entries[i], i),
            };
        });
        if (changed) this.emitConfigUpdate({ inputs });
    }

    /** "Active Inputs" panel: connected inputs, streams routed so far, mode. */
    private publishInputStatus(legacy: boolean): void {
        this.setStatusData('inputs', {
            connected: this.connectedInputs,
            streams: this.discovered.size,
            mode: legacy ? 'legacy video/audio ports' : 'generic',
        });
    }

    /** First discovery per output PID wins: the rule routes the first pad of
     *  each (demux, route class), and discovery reports pads in pad-added
     *  order — later same-class pads on that demux are the ones the rule did
     *  NOT link (sunk). The class is read from the pad's caps exactly as the
     *  hook reads it (`muxRouteMedia` is the hook classifier's twin).
     *  Feeds the "Streams Routed" status count. */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel !== 'stream:discovered') return;
        const event = payload as { from?: string; caps?: string } | null;
        if (!event?.from || typeof event.caps !== 'string') return;
        const media = muxRouteMedia(event.caps);
        const slot = this.slots.find((s) => s.demux === event.from && s.media === media);
        if (!slot || this.discovered.has(slot.pid)) return;
        this.discovered.set(slot.pid, capsStreamInfo(event.caps));
        this.publishInputStatus(isLegacyConfig(this.config));
    }
}

/** Input entry for a sink port id (`input-2`, or a legacy `video-0` / `audio-2`). */
function entryForPort(entries: InputEntry[], sinkPortId: string): InputEntry | undefined {
    return entries.find((e) => e.id === sinkPortId);
}

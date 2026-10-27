import {
    DEFAULT_MPEGTS_ALIGNMENT,
    GstPluginBase,
    ThroughputPoller,
    busInputLabel,
    busTeeName,
    capsStreamInfo,
    latInName,
    type AlignerInputRef,
    type AlignerWatchRef,
    type PipelineDescription,
    type ModuleServices,
    type StreamCapsInfo,
    type ThroughputSample,
    type TimingInputRef,
} from '@media-router/engine';
import {
    buildDynamicPorts,
    buildPipeline,
    assignInputPids,
    configPidConflicts,
    inputBusSrcName,
    inputEntries,
    normalizeKey,
    isInputPort,
    isLegacyConfig,
    MuxerPidConflictError,
    routeSeedNs,
    sortSources,
    type DynamicPort,
    type InputEntry,
    type MuxedStreamSlot,
    type UdpInputSource,
} from './mpegtsMuxerPipeline.js';
import type { MuxRouteMedia } from './muxPids.js';
import { ignoredOffsets } from './muxerInputs.js';

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
    // pipeline build. `slots` names each input's configured PID (the panel
    // row per input); `discovered` holds the caps of every stream the hook
    // routed, by OUTPUT PID (`mux:routed` events — the hook alone knows where
    // a multi-stream input's further classes landed).
    private slots: MuxedStreamSlot[] = [];
    private discovered = new Map<number, StreamCapsInfo>();
    /** Per demux: the classes the hook routed and their output PIDs. */
    private routed = new Map<string, Array<{ media: MuxRouteMedia; outPid: number }>>();
    /** Per input branch: the seed its route aligners were built with (ms). */
    private seeds: Array<number | undefined> = [];
    private connectedInputs = 0;
    private legacyNoted = false;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        const offsets = ignoredOffsets(config);
        if (offsets.length > 0) {
            this.log.warn(
                `Audio Offset removed — ignoring stored offsetMs (${offsets.join(', ')}); ` +
                    'lipsync is no longer trimmed on these inputs',
            );
        }
        // Persist every input's stable key (and PID) as soon as the module
        // exists, running or not: an operator may remove an input before the
        // first build, and the keys are what keep the other inputs' ports.
        if (!isLegacyConfig(config)) this.seedInputIdentity(config, inputEntries(config));
    }

    /** Generate one input port per configured input + a single output port. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(inputEntries(config));
    }

    /** Branch i's demux `demux_<i>` serves its pin's row, the tap of that branch (WI-P3-6). */
    protected demuxInputOf(element: string): { tap: string } | undefined {
        const branch = /^demux_(\d+)$/.exec(element)?.[1];
        return branch !== undefined ? { tap: latInName(inputBusSrcName(branch)) } : undefined;
    }

    /** Input-array edits are live only when the length is unchanged (rename)
     *  AND no entry's `language` or PID override changed. A grown/shrunk
     *  array means a different port set; a PID change alters the pad-link
     *  routes and a language change alters the branch's
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
        // The module's own seed — the next free PID and the stable key written
        // back into blank fields (see seedInputIdentity) — changes nothing on
        // the wire and must not bounce the muxer through a restart. It is
        // recognised exactly: the seed is a pure function of the previous list.
        const prevEntries = key === 'inputs' ? inputEntries({ inputs: oldValue }) : [];
        const seededPids = assignInputPids(prevEntries);
        return newValue.every((e, i) => {
            const entry = (e ?? {}) as Record<string, unknown>;
            const prev = (oldValue[i] ?? {}) as Record<string, unknown>;
            const pidUnchanged =
                (entry.pid ?? 0) === (prev.pid ?? 0) ||
                ((prev.pid ?? 0) === 0 && entry.pid === seededPids[i]);
            const keyUnchanged =
                normalizeKey(entry.key) === normalizeKey(prev.key) ||
                (normalizeKey(prev.key) === undefined && entry.key === prevEntries[i]?.key);
            return (entry.language ?? '') === (prev.language ?? '') && pidUnchanged && keyUnchanged;
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

        let entries = inputEntries(config);
        const legacy = isLegacyConfig(config);
        // Operator PIDs are checked over EVERY configured input, wired or not,
        // so a clash surfaces as soon as it is set (see configPidConflicts).
        // The wired layout is re-checked in buildPipeline.
        const pidConflicts = configPidConflicts(entries);
        if (pidConflicts.length > 0) {
            this.setHealth('error', `PID conflict — ${pidConflicts.join('; ')}`);
            return null;
        }
        if (!legacy) {
            // Seed first, then build from the SEEDED list: the PID written
            // into the field must be the PID this very run muxes on. (Building
            // from the pre-seed entries let the slot layout pick a PID from
            // the wired sources only, which can differ from the seed.)
            entries = inputEntries({ inputs: this.seedInputIdentity(config, entries) });
        }
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
            .map((s: BusSource) => {
                const entry = entryForPort(entries, s.sinkPortId);
                return {
                    sinkPortId: s.sinkPortId,
                    port: s.port,
                    socketPath: s.socketPath,
                    sourceModuleId: s.sourceModuleId,
                    language: entry?.language,
                    ...(entry?.pid !== undefined ? { pid: entry.pid } : {}),
                    ...(s.seedLatenessMs !== undefined ? { seedLatenessMs: s.seedLatenessMs } : {}),
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
        let result;
        try {
            result = buildPipeline({
                sources,
                output: endpoint,
                alignment,
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
        this.seeds = sources.map((s) => s.seedLatenessMs);
        this.discovered.clear();
        this.routed.clear();
        this.connectedInputs = sources.length;

        this.setStatusData('bus', { channel: endpoint.port });
        this.publishInputStatus(legacy);
        this.publishPidStatus(entries);

        return {
            pipeline: result.pipeline,
            runnerHooks: result.runnerHooks,
            restartOnError: true,
            // Retime every input's access units onto their producer's stamps (K +
            // PES), cue pads too: a KLV or teletext buffer leaves its demux at
            // PES − 1 h, so the mux writes it at its own PTS (part 4.6).
            alignBranchesToStamps: {
                demuxes: result.demuxes,
                transformProducer: true,
                privatePads: true,
            },
            timingInputs: timingInputs(sources, entries),
        };
    }

    /**
     * Write the next free PID into every blank `inputs[i].pid` (so the
     * settings field shows the PID actually in use instead of 0 — the
     * operator asked for exactly that, 2026-09-16) and the stable `key` into
     * every entry that lacks one (so removing an input never renames the
     * others' ports — see InputEntry.key). Goes through `emitConfigUpdate` →
     * manager persist, like the splitter's discovered streams; both values
     * are what the pure layout would have chosen anyway, and `isLiveChange`
     * recognises the seed so the echoed patch never restarts the muxer. Once
     * written they are explicit: adding inputs later never moves them.
     */
    private seedInputIdentity(config: Record<string, unknown>, entries: InputEntry[]): unknown[] {
        const raw = Array.isArray(config.inputs) ? (config.inputs as unknown[]) : [{}];
        const pids = assignInputPids(entries);
        let changed = false;
        const inputs = raw.slice(0, entries.length).map((item, i) => {
            const rec = (item ?? {}) as Record<string, unknown>;
            const seed: Record<string, unknown> = {};
            if (normalizeKey(rec.key) === undefined) seed.key = entries[i].key;
            if (entries[i].pid === undefined) seed.pid = pids[i];
            if (Object.keys(seed).length === 0) return item;
            changed = true;
            return { ...rec, ...seed };
        });
        if (changed) this.emitConfigUpdate({ inputs });
        return inputs;
    }

    /**
     * "PIDs" panel: one row per wired input — its configured PID and, once
     * the hook has linked pads, every stream routed with its output PID
     * (`video 264 · klv 265`), so an operator sees exactly what a downstream
     * splitter will discover.
     */
    private publishPidStatus(entries: InputEntry[]): void {
        const byDemux = new Map<string, MuxedStreamSlot[]>();
        for (const s of this.slots) byDemux.set(s.demux, [...(byDemux.get(s.demux) ?? []), s]);
        this.setDynamicSections(
            [...byDemux.entries()].map(([demux, slots]) => {
                const entry = entries.find((e) => e.id === slots[0].sinkPortId);
                const label = entry?.name.trim() || entry?.label || slots[0].sinkPortId;
                return {
                    id: `pids-${demux}`,
                    label: `Input ${label}`,
                    fields: [
                        { key: 'pid', label: 'PID' },
                        { key: 'streams', label: 'Streams (class → PID)' },
                    ],
                };
            }),
        );
        for (const [demux, slots] of byDemux) {
            const configured = slots[0].media === undefined ? slots[0].pid : undefined;
            const routed = this.routed.get(demux) ?? [];
            this.setStatusData(`pids-${demux}`, {
                pid: configured !== undefined ? String(configured) : 'legacy port',
                streams: routed.length
                    ? routed.map((r) => `${r.media} ${r.outPid}`).join(' · ')
                    : '— (waiting for streams)',
            });
        }
    }

    /** "Active Inputs" panel: connected inputs, streams routed so far, mode. */
    private publishInputStatus(legacy: boolean): void {
        this.setStatusData('inputs', {
            connected: this.connectedInputs,
            streams: this.discovered.size,
            mode: legacy ? 'legacy video/audio ports' : 'generic',
        });
    }

    /** A route's watch (`demux_<i>_<class>`, or a legacy slot's PID) joins its pin's row, the tap
     *  of its input branch: one row per pin, numbered like it (B-70, B-93). */
    protected alignerInputOf(watch: AlignerWatchRef): AlignerInputRef | undefined {
        const demux =
            /^(demux_\d+)_[a-z]+$/.exec(watch.input)?.[1] ??
            this.slots.find((s) => String(s.pid) === watch.input)?.demux;
        const branch = demux ? /^demux_(\d+)$/.exec(demux)?.[1] : undefined;
        return branch !== undefined ? { tap: latInName(inputBusSrcName(branch)) } : undefined;
    }

    /** `mux:routed` — the hook linked one pad: which demux, its route class,
     *  the pad's caps and the OUTPUT PID it went to (the input's own PID for
     *  the primary class, the next free one for a further class of a
     *  multi-stream source). Feeds the "Streams Routed" count and the per-input
     *  PID rows; the runner's generic `stream:discovered` is not used here
     *  because it cannot know the output PID. */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel !== 'mux:routed') return;
        const event = payload as {
            demux?: string;
            media?: string;
            outPid?: number;
            caps?: string;
        } | null;
        const outPid = Number(event?.outPid);
        if (!event?.demux || !event.media || !Number.isFinite(outPid)) return;
        if (this.discovered.has(outPid)) return;
        this.discovered.set(
            outPid,
            capsStreamInfo(typeof event.caps === 'string' ? event.caps : ''),
        );
        const list = this.routed.get(event.demux) ?? [];
        list.push({ media: event.media as MuxRouteMedia, outPid });
        this.routed.set(event.demux, list);
        // The hook built the route's aligner from the branch: its seed, for the B-26 check.
        const seedNs = routeSeedNs(this.seeds[Number(/^demux_(\d+)$/.exec(event.demux)?.[1])]);
        this.log.debug(
            {
                muxRoute: {
                    demux: event.demux,
                    media: event.media,
                    outPid,
                    seedLatenessNs: seedNs,
                },
            },
            `Route ${event.demux} ${event.media} → PID ${outPid}: seed-lateness ` +
                (seedNs === undefined ? 'none' : `${Math.round(seedNs / 1_000_000)} ms`),
        );
        this.publishPidStatus(inputEntries(this.config));
        this.publishInputStatus(isLegacyConfig(this.config));
    }
}

/** Input entry for a sink port id (`input-2`, or a legacy `video-0` / `audio-2`). */
function entryForPort(entries: InputEntry[], sinkPortId: string): InputEntry | undefined {
    return entries.find((e) => e.id === sinkPortId);
}

/** What the muxer reads of a `getModuleBusSources` entry; the router adds
 *  `seedLatenessMs` from the producer's output lateness (WI-P2-13). */
interface BusSource {
    sinkPortId: string;
    port: number;
    socketPath: string;
    sourceModuleId: string;
    seedLatenessMs?: number;
}

/** Branch i's tap reads sources[i]: its timing section is numbered like its pin (`Input n`), so
 *  an unwired or dark pin leaves a gap, and labelled by its feeding module. */
function timingInputs(sources: UdpInputSource[], entries: InputEntry[]): TimingInputRef[] {
    return sources.map((s, i) => {
        const pin = entries.findIndex((e) => e.id === s.sinkPortId);
        return {
            tap: latInName(inputBusSrcName(String(i))),
            n: pin >= 0 ? pin + 1 : entries.length + i + 1,
            label: busInputLabel(s),
        };
    });
}

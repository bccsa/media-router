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
    isAudioInputPort,
    isVideoInputPort,
    sortSources,
    streamEntries,
    type DynamicPort,
    type MuxedStreamPid,
    type UdpInputSource,
} from './mpegtsMuxerPipeline.js';
import { buildKlvPayload, serializeKlvPayload, type NamedStreamInput } from './klvPayload.js';
/**
 * MPEG-TS Muxer plugin.
 *
 * Combines several muxed/mpegts UDP-multicast streams into one. Each connected
 * input port is demuxed back to its elementary streams and re-muxed into a
 * single transport stream, then sent to the output multicast group assigned by
 * MediaRouter. PID collisions are handled by mpegtsmux itself.
 */
export class MpegTsMuxerModule extends GstPluginBase {
    // The stream arrays are live for renames only: a name edit changes only a
    // label and never the port set, so it applies without a pipeline rebuild;
    // adding/removing an entry changes the port set and routes through the
    // pending-restart path via `isLiveChange` below.
    protected liveUpdatableParams: string[] = ['videoStreams', 'audioStreams'];

    /** Output-bitrate poller on the udpsink. */
    private readonly throughput = new ThroughputPoller({
        getBytes: () => this.readSinkBytes(),
        publish: (sample) => this.publishThroughput(sample),
    });
    /** Bus egress element to poll for throughput, resolved at build time: the
     *  fan-out `tee` (busTeeName). */
    private busSinkName: string | undefined;

    // In-band stream-info state (KLV carousel), rebuilt on every pipeline
    // build. `streamPids` joins `stream:discovered` events (demux element +
    // media) back to output PIDs; `discovered` holds the first caps seen per
    // output PID (the first matching pad is the one the link rule routed);
    // `hasStreamInfo` gates all pushes (no `klvsrc` in the pipeline → no-op).
    private streamPids: MuxedStreamPid[] = [];
    private discovered = new Map<number, StreamCapsInfo>();
    private hasStreamInfo = false;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** Generate one input port per configured video/audio stream + a single output port. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(streamEntries(config, 'video'), streamEntries(config, 'audio'));
    }

    /** Stream-array edits are live only when the length is unchanged (rename)
     *  AND no entry's `offsetMs` or `language` changed. A grown/shrunk array
     *  means a different port set; an offset change alters the pad-link rules
     *  and a language change alters the branch's `taginject` — both are
     *  applied at build time, so treating them as live would silently swallow
     *  the edit. All route through pending-restart. */
    isLiveChange(key: string, newValue: unknown, oldValue: unknown): boolean {
        if (key !== 'videoStreams' && key !== 'audioStreams') return true;
        if (
            !Array.isArray(newValue) ||
            !Array.isArray(oldValue) ||
            newValue.length !== oldValue.length
        ) {
            return false;
        }
        return newValue.every((e, i) => {
            const entry = e as { offsetMs?: unknown; language?: unknown } | null;
            const prev = oldValue[i] as { offsetMs?: unknown; language?: unknown } | null;
            return (
                (entry?.offsetMs ?? 0) === (prev?.offsetMs ?? 0) &&
                (entry?.language ?? '') === (prev?.language ?? '')
            );
        });
    }

    async onStart(): Promise<void> {
        await super.onStart();
        // Poll udpsink bytes-served every 2s. The poller's counter-reset guard
        // turns the udpsink counter resetting to 0 on a child re-spawn
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

        // Per-input names for the in-band carousel (plan D4): operator-set
        // label from the stream array entry matching the sink port's index,
        // falling back to `sourceModuleId` from the connection record inside
        // the pipeline builder.
        const allSources = router.getModuleBusSources(instanceId);
        const muxedSources: UdpInputSource[] = allSources
            .filter((s) => isVideoInputPort(s.sinkPortId) || isAudioInputPort(s.sinkPortId))
            .map((s) => {
                const entry = entryForPort(config, s.sinkPortId);
                return {
                    sinkPortId: s.sinkPortId,
                    port: s.port,
                    name: entry?.name,
                    sourceModuleId: s.sourceModuleId,
                    socketPath: s.socketPath,
                    offsetMs: entry?.offsetMs,
                    language: entry?.language,
                };
            });
        const sources = sortSources(muxedSources);

        // Parser selection is now done by the Python pad-link runner from
        // each pad's caps at pad-added time — unsupported codecs surface as
        // a runner-emitted warning, not as a pre-flight pipeline refusal.

        const videoCount = sources.filter((s) => isVideoInputPort(s.sinkPortId)).length;
        const audioCount = sources.filter((s) => isAudioInputPort(s.sinkPortId)).length;

        if (sources.length === 0) {
            this.setHealth('warning', 'No inputs connected — connect at least one encoder');
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
        const result = buildPipeline({
            sources,
            output: endpoint,
            alignment,
            queueLeaky,
            queueDepthMs,
            emitStreamInfo: (config.emitStreamInfo as boolean) ?? true,
            videoParserBypass: config.videoParserBypass === true,
        });
        if (!result) return null;

        // Stream-info state for this build: discovery is per-pipeline (a
        // rebuild re-fires every pad-added), so stale codec info must not
        // leak across builds.
        this.streamPids = result.streamPids;
        this.hasStreamInfo = result.hasStreamInfo;
        this.discovered.clear();

        this.setStatusData('bus', { channel: endpoint.port });
        this.setStatusData('inputs', { video: videoCount, audio: audioCount });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
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

    /** Re-seed the carousel on every PLAYING transition — the runner clears
     *  its payload store on each (re)start, and a crash-restart re-fires
     *  discovery, so pushing the name-only payload here is never stale. */
    protected onPipelinePlaying(): void {
        this.pushStreamInfo();
    }

    /** First discovery per output PID wins: the pad-link rule routes the
     *  first matching pad of each (demux, media), and discovery reports pads
     *  in pad-added order — later same-media pads on that demux are the ones
     *  the rule did NOT link. */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel !== 'stream:discovered') return;
        const event = payload as { from?: string; media?: string; caps?: string } | null;
        if (!event?.from || !event.media || typeof event.caps !== 'string') return;
        const stream = this.streamPids.find(
            (s) => s.demux === event.from && s.media === event.media,
        );
        if (!stream || this.discovered.has(stream.pid)) return;
        this.discovered.set(stream.pid, capsStreamInfo(event.caps));
        this.pushStreamInfo();
    }

    /** Live rename path: the stream arrays are live for name-only edits (see
     *  isLiveChange), and a rename only needs a carousel re-push. */
    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await super.onLiveConfigUpdate(changes);
        if ('videoStreams' in changes || 'audioStreams' in changes) this.pushStreamInfo();
    }

    /** Build + push the current carousel payload (names always; codec info
     *  only for non-native codecs per the klvPayload layering rule). */
    private pushStreamInfo(): void {
        if (!this.hasStreamInfo) return;
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        const bySinkPort = new Map(
            (router?.getModuleBusSources(instanceId) ?? []).map((s) => [
                s.sinkPortId,
                s.sourceModuleId,
            ]),
        );
        const inputs: NamedStreamInput[] = this.streamPids.map((s) => ({
            pid: s.pid,
            media: s.media,
            sinkPortId: s.sinkPortId,
            name: entryForPort(this.config, s.sinkPortId)?.name,
            sourceModuleId: bySinkPort.get(s.sinkPortId),
            discovered: this.discovered.get(s.pid),
        }));
        this.setKlvPayload('klvsrc', serializeKlvPayload(buildKlvPayload(inputs)));
    }
}

/** Stream entry for a sink port id (`video-0` / `audio-2`) from the config
 *  stream arrays (legacy count+map configs are normalised by `streamEntries`).
 *  Carries the operator label (blank = unset), the lipsync offsetMs and the
 *  ISO 639 language. */
function entryForPort(
    config: Record<string, unknown>,
    sinkPortId: string,
): { name: string; offsetMs: number; language: string } | undefined {
    const media = isVideoInputPort(sinkPortId) ? 'video' : 'audio';
    const idx = Number(sinkPortId.slice(media.length + 1));
    if (!Number.isInteger(idx) || idx < 0) return undefined;
    return streamEntries(config, media)[idx];
}

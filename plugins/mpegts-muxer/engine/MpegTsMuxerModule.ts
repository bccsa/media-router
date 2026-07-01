import {
    DEFAULT_MPEGTS_ALIGNMENT,
    GstPluginBase,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';
import {
    KLV_APPSRC_NAME,
    buildDynamicPorts,
    buildPipeline,
    isAudioInputPort,
    isVideoInputPort,
    sortSources,
    streamEntries,
    type DynamicPort,
    type UdpInputSource,
} from './mpegtsMuxerPipeline.js';
import { buildKlvPayload, serializeKlvPayload } from './klvPayload.js';
import type { NamedStreamInput } from './klvPayload.js';

/**
 * MPEG-TS Muxer plugin.
 *
 * Combines several muxed/mpegts UDP-multicast streams into one. Each connected
 * input port is demuxed back to its elementary streams and re-muxed into a
 * single transport stream, then sent to the output multicast group assigned by
 * MediaRouter. PID collisions are handled by mpegtsmux itself.
 */
export class MpegTsMuxerModule extends GstPluginBase {
    // The stream arrays are live for renames only: editing a name re-pushes
    // the KLV carousel without a pipeline rebuild (plan D4/Phase 2), while
    // adding/removing an entry changes the port set and routes through the
    // pending-restart path via `isLiveChange` below.
    protected liveUpdatableParams: string[] = ['videoStreams', 'audioStreams'];

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private lastBytes = 0;
    private lastPollTime = 0;
    /** PID-keyed identity of the streams currently muxed, captured at build
     *  time so a live name edit can rebuild the carousel without re-deriving
     *  the pipeline. Empty until the pipeline is built. */
    private namedStreams: NamedStreamInput[] = [];

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** Generate one input port per configured video/audio stream + a single output port. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(
            streamEntries(config, 'video').length,
            streamEntries(config, 'audio').length,
        );
    }

    /** Stream-array edits are live only when the length is unchanged (rename).
     *  A grown/shrunk array means a different port set → pipeline rebuild. */
    isLiveChange(key: string, newValue: unknown, oldValue: unknown): boolean {
        if (key !== 'videoStreams' && key !== 'audioStreams') return true;
        return (
            Array.isArray(newValue) &&
            Array.isArray(oldValue) &&
            newValue.length === oldValue.length
        );
    }

    async onStart(): Promise<void> {
        this.namedStreams = [];
        await super.onStart();
        // Push the name carousel once the appsrc exists (PLAYING). The runner's
        // ~50 ms carousel timer keeps re-pushing after that; this just makes the
        // first labels appear without waiting a full tick. Re-pushed on every
        // PLAYING so a restartOnError re-spawn re-seeds the carousel.
        this.childProcess?.on('stateChange', (data: { state: string }) => {
            if (data.state === 'playing') this.pushKlvCarousel();
        });
        // Seed the carousel directly here, not only on the `playing` edge.
        // mpegtsmux is an aggregator: it produces no output until EVERY sink
        // pad (video, audio, AND the KLV metadata appsrc) has delivered a
        // buffer. The `playing` stateChange that drives the carousel is racy —
        // if it's missed, the KLV appsrc never gets a buffer and the whole mux
        // stalls (the "muxer outputs nothing" bug). Pushing here, right after
        // the pipeline is built and the runner is up, guarantees the runner
        // receives the payload; its ~50 ms carousel timer then re-pushes once
        // the appsrc reaches PLAYING. (The carousel is 50 ms, NOT 1 s, because
        // mpegtsmux gates its output on the oldest pad timestamp — a 1 s
        // metadata cadence throttled the muxed A/V to ~8 % of bitrate. See the
        // comment in gst-pipeline-runner.py.) namedStreams is populated by
        // buildPipeline (run inside super.onStart above).
        this.pushKlvCarousel();
        this.lastBytes = 0;
        this.lastPollTime = Date.now();
        this.statsTimer = setInterval(async () => {
            try {
                const bytesServed = (await this.getElementProperty(
                    'usink',
                    'bytes-served',
                )) as number;
                if (typeof bytesServed === 'number') {
                    const now = Date.now();
                    const elapsed = (now - this.lastPollTime) / 1000;
                    // udpsink resets `bytes-served` to 0 each time the runner
                    // re-spawns the Python process (restartOnError). Detect
                    // that as `bytesServed < lastBytes` and treat the next
                    // sample as a fresh baseline instead of reporting a
                    // negative bitrate.
                    const counterReset = bytesServed < this.lastBytes;
                    const deltaBytes = counterReset ? 0 : bytesServed - this.lastBytes;
                    const bitrateKbps =
                        elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0;
                    this.lastBytes = bytesServed;
                    this.lastPollTime = now;
                    this.setStatusData('throughput', {
                        'Output Bitrate': `${bitrateKbps} kbps`,
                        'Total Bytes': `${(bytesServed / 1024 / 1024).toFixed(1)} MB`,
                    });
                }
            } catch {
                /* ignore */
            }
        }, 2000);
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) {
            clearInterval(this.statsTimer);
            this.statsTimer = null;
        }
        await super.onStop();
    }

    /** A live stream rename re-pushes the carousel — labels update downstream
     *  without a pipeline rebuild (plan D4/Phase 2). */
    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await super.onLiveConfigUpdate(changes);
        if ('videoStreams' in changes || 'audioStreams' in changes) this.pushKlvCarousel();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        // Per-input names for the in-band carousel (plan D4): operator-set
        // label from the stream array entry matching the sink port's index,
        // falling back to `sourceModuleId` from the connection record inside
        // the pipeline builder.
        const allSources = router.getModuleUdpSources(instanceId);
        const muxedSources: UdpInputSource[] = allSources
            .filter(
                (s) =>
                    isVideoInputPort(s.sinkPortId) ||
                    isAudioInputPort(s.sinkPortId),
            )
            .map((s) => ({
                sinkPortId: s.sinkPortId,
                host: s.host,
                port: s.port,
                name: nameForPort(config, s.sinkPortId),
                sourceModuleId: s.sourceModuleId,
            }));
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

        const endpoint = router.assignUdpPort(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free UDP ports available');
            return null;
        }

        const alignment = (config.alignment as number) ?? DEFAULT_MPEGTS_ALIGNMENT;
        const bufferMs = (config.bufferMs as number) ?? 50;
        const result = buildPipeline({
            sources,
            output: endpoint,
            alignment,
            bufferMs,
        });
        if (!result) return null;

        // Capture the PID-keyed identity so a live name edit can re-push the
        // carousel without rebuilding the pipeline.
        this.namedStreams = result.namedStreams;

        this.setStatusData('udp', { host: endpoint.host, port: endpoint.port });
        this.setStatusData('inputs', { video: videoCount, audio: audioCount });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
            restartOnError: true,
        };
    }

    /** Build the carousel payload from the captured streams + current config
     *  names, and push it to the runner. Always emits — even with zero named
     *  inputs names fall back to `sourceModuleId`, so the demuxer always sees
     *  the channel (plan: never goes silent on zero named inputs). */
    private pushKlvCarousel(): void {
        if (this.namedStreams.length === 0) return;
        // Re-apply the latest operator names. The captured `namedStreams`
        // already carry the sourceModuleId fallback and the sink port id each
        // stream entered on; only the explicit name can change live, and it
        // lives in the config stream arrays indexed by port. (Never derive the
        // port from the PID: PIDs are numbered by connected-source ordinal,
        // ports by config index — they diverge when wired ports aren't a
        // contiguous prefix.)
        const withNames = this.namedStreams.map((s) => ({
            ...s,
            name: nameForPort(this.config, s.sinkPortId) ?? s.name,
        }));
        const payload = serializeKlvPayload(buildKlvPayload(withNames));
        this.setKlvPayload(KLV_APPSRC_NAME, payload);
    }
}

/** Operator name for a sink port id (`video-0` / `audio-2`) from the config
 *  stream arrays (legacy count+map configs are normalised by `streamEntries`).
 *  Blank means unset — `resolveStreamName` then falls back to the source
 *  module id. */
function nameForPort(
    config: Record<string, unknown>,
    sinkPortId: string,
): string | undefined {
    const media = isVideoInputPort(sinkPortId) ? 'video' : 'audio';
    const idx = Number(sinkPortId.slice(media.length + 1));
    if (!Number.isInteger(idx) || idx < 0) return undefined;
    return streamEntries(config, media)[idx]?.name;
}

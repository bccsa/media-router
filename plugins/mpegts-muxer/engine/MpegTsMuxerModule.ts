import {
    DEFAULT_MPEGTS_ALIGNMENT,
    GstPluginBase,
    ThroughputPoller,
    busTransport,
    busTeeName,
    type PipelineDescription,
    type ModuleServices,
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
    type UdpInputSource,
} from './mpegtsMuxerPipeline.js';

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
     *  fan-out `tee` (busTeeName) under unixfd, the `usink` udpsink under UDP. */
    private busSinkName: string | undefined;

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
                socketPath: s.socketPath,
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
        this.busSinkName = busTransport() === 'unixfd' ? busTeeName(endpoint.port) : 'usink';

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
        });
        if (!result) return null;

        this.setStatusData('udp', { host: endpoint.host, port: endpoint.port });
        this.setStatusData('inputs', { video: videoCount, audio: audioCount });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
            restartOnError: true,
        };
    }
}

/** Operator name for a sink port id (`video-0` / `audio-2`) from the config
 *  stream arrays (legacy count+map configs are normalised by `streamEntries`).
 *  Populates the input source label; blank means unset. */
function nameForPort(
    config: Record<string, unknown>,
    sinkPortId: string,
): string | undefined {
    const media = isVideoInputPort(sinkPortId) ? 'video' : 'audio';
    const idx = Number(sinkPortId.slice(media.length + 1));
    if (!Number.isInteger(idx) || idx < 0) return undefined;
    return streamEntries(config, media)[idx]?.name;
}

import {
    DEFAULT_MPEGTS_ALIGNMENT,
    GstPluginBase,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';
import {
    buildDynamicPorts,
    buildPipeline,
    isAudioInputPort,
    isVideoInputPort,
    sortSources,
    videoParserForCodec,
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
    protected liveUpdatableParams: string[] = [];

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private lastBytes = 0;
    private lastPollTime = 0;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** Generate one input port per configured video/audio stream + a single output port. */
    getDynamicPorts(): DynamicPort[] {
        const v = Math.max(0, (this.config.videoStreamCount as number) ?? 1);
        const a = Math.max(0, (this.config.audioStreamCount as number) ?? 1);
        return buildDynamicPorts(v, a);
    }

    async onStart(): Promise<void> {
        await super.onStart();
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

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

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
                codec: s.codec,
            }));
        const sources = sortSources(muxedSources);

        // Refuse the run when a connected video input uses a codec we can't
        // re-mux — surface a health warning instead of letting the runner
        // restart-loop on `pad link failed`.
        const unsupported = sources.filter(
            (s) => isVideoInputPort(s.sinkPortId) && videoParserForCodec(s.codec) === null,
        );
        if (unsupported.length > 0) {
            const codecs = Array.from(new Set(unsupported.map((s) => s.codec ?? 'unknown')));
            this.setHealth(
                'warning',
                `Unsupported video codec on input: ${codecs.join(', ')}`,
            );
            return null;
        }

        const videoCount = sources.filter((s) => isVideoInputPort(s.sinkPortId)).length;
        const audioCount = sources.filter((s) => isAudioInputPort(s.sinkPortId)).length;

        if (sources.length === 0) {
            this.setHealth('warning', 'No inputs connected — connect at least one encoder');
            return null;
        }

        const endpoint = router.assignEncoderPort(instanceId);
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

        this.setStatusData('udp', { host: endpoint.host, port: endpoint.port });
        this.setStatusData('inputs', { video: videoCount, audio: audioCount });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
            restartOnError: true,
        };
    }
}

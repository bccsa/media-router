import {
    GstPluginBase,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';
import {
    audioPortId,
    buildDynamicPorts,
    buildPipeline,
    videoPortId,
    type DemuxerOutput,
    type DynamicPort,
} from './mpegtsDemuxerPipeline.js';

/**
 * MPEG-TS Demuxer plugin.
 *
 * Receives one muxed/mpegts UDP-multicast stream and splits its elementary
 * streams into per-output multicast groups. Each output port is allocated
 * its own UDP port via `MediaRouter.assignEncoderPort(moduleId, portId)`.
 *
 * Pad fan-out is performed at runtime via `linkOnPadAdded` rules — the Nth
 * pad-added event of each media type is linked to the Nth configured output
 * port for that media type.
 */
export class MpegTsDemuxerModule extends GstPluginBase {
    protected liveUpdatableParams: string[] = [];

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** One input port + N video outputs + M audio outputs, sized from config. */
    getDynamicPorts(): DynamicPort[] {
        const v = Math.max(0, (this.config.videoStreamCount as number) ?? 1);
        const a = Math.max(0, (this.config.audioStreamCount as number) ?? 1);
        return buildDynamicPorts(v, a);
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const upstream = router.getModuleUdpSource(instanceId);
        if (!upstream) {
            this.setHealth('warning', 'No upstream MPEG-TS source connected');
            return null;
        }

        const videoCount = Math.max(0, (config.videoStreamCount as number) ?? 1);
        const audioCount = Math.max(0, (config.audioStreamCount as number) ?? 1);

        const allocate = (portId: string): DemuxerOutput | null => {
            const ep = router.assignEncoderPort(instanceId, portId);
            if (!ep) return null;
            return { portId, host: ep.host, port: ep.port };
        };

        const videoOutputs: DemuxerOutput[] = [];
        for (let i = 0; i < videoCount; i++) {
            const out = allocate(videoPortId(i));
            if (!out) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${videoPortId(i)}`);
                return null;
            }
            videoOutputs.push(out);
        }
        const audioOutputs: DemuxerOutput[] = [];
        for (let i = 0; i < audioCount; i++) {
            const out = allocate(audioPortId(i));
            if (!out) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${audioPortId(i)}`);
                return null;
            }
            audioOutputs.push(out);
        }

        if (videoOutputs.length + audioOutputs.length === 0) {
            this.setHealth('warning', 'No outputs configured — set videoStreamCount or audioStreamCount');
            return null;
        }

        const bufferMs = (config.bufferMs as number) ?? 50;
        const videoCodec = (config.videoCodec as string) ?? 'h264';
        const result = buildPipeline({
            input: { host: upstream.host, port: upstream.port },
            videoOutputs,
            audioOutputs,
            bufferMs,
            videoCodec,
        });
        if (!result) return null;

        this.setStatusData('input', { host: upstream.host, port: upstream.port });
        this.setStatusData('outputs', {
            video: videoOutputs.length,
            audio: audioOutputs.length,
        });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
            restartOnError: true,
        };
    }
}

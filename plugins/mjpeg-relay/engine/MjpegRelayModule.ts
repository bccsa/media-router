import {
    GstPluginBase,
    acquireV4l2Demand,
    parseResolution,
    registerV4l2DeviceProvider,
    releaseV4l2Demand,
    suspendV4l2Enumeration,
    type EngineServices,
    type PipelineDescription,
} from '@media-router/engine';

/**
 * Build the relay pipeline. Pure string assembly, exported for tests.
 *
 * Deliberately NO `jpegparse` and NO decode: the camera's complete MJPG frames
 * go straight into RTP/JPEG (RFC 2435). This is the entire point — the path
 * from capture to wire adds no codec latency at all (~measured 5-10 ms). The
 * tradeoff, accepted for a monitor feed: a camera in the ATEM rotated-frame
 * state (see the video-encoder's jpegparse note) shows as broken picture here
 * instead of being repaired.
 */
export function buildRelayPipeline(
    device: string,
    width: number,
    height: number,
    framerate: number,
    host: string,
    port: number,
): string {
    return (
        `v4l2src device=${device} ! image/jpeg,width=${width},height=${height},framerate=${framerate}/1 ` +
        `! rtpjpegpay ! udpsink host=${host} port=${port} sync=false`
    );
}

/**
 * MJPEG Relay plugin — the low-latency monitor sender.
 *
 * Runs OUTSIDE the MPEG-TS bus on purpose: the bus is muxed TS with producer
 * stamping and consumer pacing, all of which trade latency for robustness.
 * This module is the opposite trade, for one job: get the camera's picture
 * onto a nearby screen as fast as physically possible.
 */
export class MjpegRelayModule extends GstPluginBase {
    static registerServices(services: EngineServices): void {
        registerV4l2DeviceProvider(services);
    }

    private v4l2DemandHeld = false;

    constructor() {
        super();
        acquireV4l2Demand();
        this.v4l2DemandHeld = true;
    }

    async onDestroy(): Promise<void> {
        if (this.v4l2DemandHeld) {
            this.v4l2DemandHeld = false;
            releaseV4l2Demand();
        }
        await super.onDestroy();
    }

    async onStart(): Promise<void> {
        // Same startup protection as the video-encoder (see its `onStart`): a
        // concurrent /dev/video* open can wedge V4L2 setup on the Pi. Only
        // when a device is configured — an unconfigured module must not
        // freeze the device picker the operator is about to use.
        if (this.config.device) suspendV4l2Enumeration(10_000);
        await super.onStart();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const device = (config.device as string) ?? '';
        if (!device) {
            this.setHealth('warning', 'No V4L2 device selected');
            return null;
        }
        const host = ((config.host as string) ?? '').trim();
        if (!host) {
            this.setHealth('warning', 'No destination host configured');
            return null;
        }
        const { width, height } = parseResolution((config.resolution as string) ?? '1920x1080');
        const framerate = (config.framerate as number) ?? 50;
        const port = (config.port as number) ?? 5008;

        this.setStatusData('relay', {
            mode: `MJPG ${width}x${height}@${framerate}`,
            destination: `${host}:${port}`,
        });

        return {
            pipeline: buildRelayPipeline(device, width, height, framerate, host, port),
            restartOnError: true,
        };
    }
}

export default MjpegRelayModule;

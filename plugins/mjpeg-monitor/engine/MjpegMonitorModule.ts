import { GstPluginBase, ensureWaylandEnv, type PipelineDescription } from '@media-router/engine';

/**
 * Build the monitor pipeline. Pure string assembly, exported for tests.
 *
 * `sync=false` is the latency contract of this module: frames present the
 * moment they are decoded, no clock wait, no jitter buffer — a late frame is
 * shown late rather than delayed further, and the eye never waits on a queue.
 */
export function buildMonitorPipeline(port: number, fullscreen: boolean): string {
    return (
        `udpsrc port=${port} address=0.0.0.0 ` +
        'caps=application/x-rtp,media=(string)video,encoding-name=(string)JPEG,payload=(int)26,clock-rate=(int)90000 ' +
        `! rtpjpegdepay ! jpegdec ! videoconvert ! waylandsink sync=false${fullscreen ? ' fullscreen=true' : ''}`
    );
}

/** MJPEG Monitor plugin — the low-latency display end of an MJPEG Relay. */
export class MjpegMonitorModule extends GstPluginBase {
    static registerServices(): void {
        ensureWaylandEnv();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const port = (config.port as number) ?? 5008;
        const fullscreen = (config.fullscreen as boolean) ?? true;
        this.setStatusData('monitor', { listen: `0.0.0.0:${port} (RTP/JPEG)` });
        return {
            pipeline: buildMonitorPipeline(port, fullscreen),
            restartOnError: true,
        };
    }
}

export default MjpegMonitorModule;

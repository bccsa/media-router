import {
    GstPluginBase,
    ThroughputPoller,
    ENCODER_ELEMENTS,
    H264_PROFILES,
    SPEED_PRESETS,
    resolveImpl,
    probeEncoderAvailability,
    applyEncoderAvailabilityToManifest,
    type CodecId,
    type H264Profile,
    type ImplId,
    type PipelineDescription,
    type SpeedPreset,
    type ThroughputSample,
} from '@media-router/engine';
import { buildPipeline } from './transcoderPipeline.js';
import {
    buildDynamicPorts,
    outputPortId,
    readRenditions,
    type DynamicPort,
    type Rendition,
    type TranscoderOutput,
} from './transcoderPorts.js';

/**
 * Video Transcoder plugin (ABR ladder).
 *
 * Receives one muxed/mpegts video stream, decodes it ONCE, and re-encodes it
 * into several quality renditions — each with its own width, height and bitrate
 * — sending every rendition to its own UDP multicast group as MPEG-TS. One
 * output port is generated per configured rendition (`getDynamicPorts`), so the
 * Vue Flow node grows an output handle for each quality the operator adds.
 *
 * Decode-once / encode-many is what makes this cheaper than wiring N separate
 * decoders: the shared `tee` fans the single decoded frame out to every
 * encoder. Encoder selection (codec + impl) reuses the same shared CBR-tuned
 * branch builder as the Video Encoder plugin.
 *
 * Nothing here is live-tweakable — renditions / codec / framerate all change the
 * pipeline shape (or the port set), so every edit rebuilds. The base class's
 * empty `liveUpdatableParams` default is exactly right, so it isn't overridden.
 */
export class TranscoderModule extends GstPluginBase {
    /** udpsink element names captured at build time, for the throughput poll. */
    private sinkNames: string[] = [];
    /** Aggregate output-bitrate poller across every rendition's udpsink. */
    private readonly throughput = new ThroughputPoller({
        getBytes: () => this.sumSinkBytes(),
        publish: (sample) => this.publishThroughput(sample),
    });

    /** Runtime availability map — populated by `initManifest` after probing. */
    private static availableImpls: Record<CodecId, ImplId[]> = { h264: [], h265: [], av1: [] };

    static async initManifest(manifest: Record<string, any>): Promise<void> {
        const availability = await probeEncoderAvailability(ENCODER_ELEMENTS);
        TranscoderModule.availableImpls = availability;
        applyEncoderAvailabilityToManifest(manifest, availability);
    }

    /** Exposed for tests. */
    static getAvailableImpls(): Record<CodecId, ImplId[]> {
        return TranscoderModule.availableImpls;
    }

    /** Exposed for tests. */
    static setAvailableImpls(availability: Record<CodecId, ImplId[]>): void {
        TranscoderModule.availableImpls = availability;
    }

    /** One MPEG-TS input + one MPEG-TS output per configured rendition. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readRenditions(config));
    }

    async onStart(): Promise<void> {
        // super.onStart() invokes buildPipeline, which populates the input /
        // encoder status sections; no separate status push needed here.
        await super.onStart();
        this.throughput.start();
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
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

        const renditions = readRenditions(config);
        if (renditions.length === 0) {
            this.setHealth('warning', 'No renditions configured — add at least one output');
            return null;
        }

        const codec = (config.codec as CodecId) ?? 'h264';
        const impl = resolveImpl(
            codec,
            (config.encoderImpl as ImplId | 'auto') ?? 'auto',
            TranscoderModule.availableImpls[codec] ?? [],
        );
        if (!impl) {
            this.setHealth(
                'error',
                `No encoder available for ${codec} — install a compatible GStreamer plugin`,
            );
            return null;
        }

        const outputs: TranscoderOutput[] = [];
        for (let i = 0; i < renditions.length; i++) {
            const portId = outputPortId(i);
            const ep = router.assignUdpPort(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, host: ep.host, port: ep.port, rendition: renditions[i] });
        }

        const framerate = (config.framerate as number) ?? 50;
        const gopFrames = (config.gopFrames as number) ?? 50;
        const bufferMs = (config.bufferMs as number) ?? 200;
        const decodeThreads = config.cpuDecodeThreading === 'single' ? 'single' : 'multi';
        const rateControl = config.rateControl === 'vbr' ? 'vbr' : 'cbr';
        // Validate against the known set so a malformed config can't splice an
        // arbitrary token into the gst-launch string; fall back to 'ultrafast'.
        const speedPreset = SPEED_PRESETS.includes(config.speedPreset as SpeedPreset)
            ? (config.speedPreset as SpeedPreset)
            : 'ultrafast';
        const h264Profile = H264_PROFILES.includes(config.h264Profile as H264Profile)
            ? (config.h264Profile as H264Profile)
            : 'auto';
        // Clamp the scene-cut threshold to x264's valid 0–100 range (0 = off).
        const rawSceneCut = Math.round(Number(config.sceneCut));
        const sceneCut = Number.isFinite(rawSceneCut) ? Math.min(100, Math.max(0, rawSceneCut)) : 40;
        const result = buildPipeline({
            input: { host: upstream.host, port: upstream.port },
            outputs,
            codec,
            impl,
            framerate,
            gopFrames,
            bufferMs,
            decodeThreads,
            rateControl,
            speedPreset,
            h264Profile,
            sceneCut,
            timeoutNs: 5_000_000_000,
        });
        if (!result) return null;

        this.sinkNames = result.sinkNames;
        this.setStatusData('input', { host: upstream.host, port: upstream.port });
        this.setStatusData('encoder', {
            codec,
            impl,
            framerate: `${framerate} fps`,
            renditions: this.renditionSummary(renditions),
        });
        this.setHealth('ok');

        // Decode threading is set INLINE in the pipeline (explicit
        // `avdec_h264 thread-type=frame`, see buildPipeline) rather than left to
        // the engine runner's decoder auto-plug hook, which does not reliably
        // apply it.
        return {
            pipeline: result.pipeline,
            restartOnError: true,
        };
    }

    // --- internals ---

    private renditionSummary(renditions: Rendition[]): string {
        return renditions.map((r) => `${r.width}x${r.height}@${r.bitrate}k`).join(', ');
    }

    /**
     * Sum `bytes-served` across every rendition's udpsink for the aggregate
     * output bitrate — polled in parallel via Promise.all. Returns undefined
     * (poller skips the tick) when the pipeline is idle or ANY sink's counter is
     * unavailable: a partial total would read as a bitrate dip. The poller's
     * counter-reset guard turns the udpsink counter resetting to 0 on a child
     * re-spawn into a fresh baseline rather than a negative rate.
     */
    private async sumSinkBytes(): Promise<number | undefined> {
        if (this.sinkNames.length === 0) return undefined;
        const served = await Promise.all(
            this.sinkNames.map((name) => this.getElementProperty(name, 'bytes-served')),
        );
        if (served.some((v) => typeof v !== 'number')) return undefined;
        return (served as number[]).reduce((sum, v) => sum + v, 0);
    }

    private publishThroughput(sample: ThroughputSample): void {
        this.setStatusData('throughput', {
            'Output Bitrate': `${sample.bitrateKbps} kbps`,
            'Total Bytes': `${(sample.totalBytes / 1024 / 1024).toFixed(1)} MB`,
        });
    }
}

import {
    GstPluginBase,
    probeGstElement,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    ENCODER_ELEMENTS,
    H264_PROFILES,
    resolveImpl,
    SPEED_PRESETS,
    type CodecId,
    type H264Profile,
    type ImplId,
    type SpeedPreset,
} from './encoderBranch.js';
import {
    buildDynamicPorts,
    buildPipeline,
    outputPortId,
    readRenditions,
    type DynamicPort,
    type Rendition,
    type TranscoderOutput,
} from './transcoderPipeline.js';

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
 */
export class TranscoderModule extends GstPluginBase {
    // Renditions / codec / framerate all change the pipeline shape (or the port
    // set) — none are live-tweakable, so every edit rebuilds.
    protected liveUpdatableParams: string[] = [];

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private lastBytes = 0;
    private lastPollTime = 0;
    /** udpsink element names captured at build time, for the throughput poll. */
    private sinkNames: string[] = [];

    /** Runtime availability map — populated by `initManifest` after probing. */
    private static availableImpls: Record<CodecId, ImplId[]> = { h264: [], h265: [], av1: [] };

    static async initManifest(manifest: Record<string, any>): Promise<void> {
        const availability: Record<CodecId, ImplId[]> = { h264: [], h265: [], av1: [] };
        await Promise.all(
            (Object.keys(ENCODER_ELEMENTS) as CodecId[]).flatMap((codec) =>
                (Object.entries(ENCODER_ELEMENTS[codec]) as Array<[ImplId, string]>).map(
                    async ([impl, element]) => {
                        if (await probeGstElement(element)) availability[codec].push(impl);
                    },
                ),
            ),
        );
        TranscoderModule.availableImpls = availability;

        const props = (manifest.configSchema as any)?.properties;
        if (!props) return;

        const availableCodecs = (Object.keys(availability) as CodecId[]).filter(
            (c) => availability[c].length > 0,
        );
        if (props.codec && availableCodecs.length > 0) {
            props.codec.enum = availableCodecs;
        }
        // Narrow the impl dropdown to entries the UI can actually honour per codec.
        if (props.encoderImpl) {
            const implMap: Record<string, string[]> = {};
            for (const c of Object.keys(availability) as CodecId[]) {
                implMap[c] = ['auto', ...availability[c]];
            }
            props.encoderImpl['x-enumBy'] = { field: 'codec', map: implMap };
        }
    }

    /** Exposed for tests. */
    static getAvailableImpls(): Record<CodecId, ImplId[]> {
        return TranscoderModule.availableImpls;
    }

    /** Exposed for tests. */
    static setAvailableImpls(availability: Record<CodecId, ImplId[]>): void {
        TranscoderModule.availableImpls = availability;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    /** One MPEG-TS input + one MPEG-TS output per configured rendition. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readRenditions(config));
    }

    async onStart(): Promise<void> {
        // super.onStart() invokes buildPipeline, which populates the input /
        // encoder status sections; no separate status push needed here.
        await super.onStart();
        this.startStatsTimer();
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

        this.sinkNames = outputs.map((_, i) => `usink_${i}`);
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
     * Sum `bytes-served` across every rendition's udpsink for an aggregate
     * output bitrate. udpsink resets the counter to 0 when the runner re-spawns
     * the child (restartOnError), so a sample below the last total is treated as
     * a fresh baseline rather than reported as a negative rate.
     */
    private startStatsTimer(): void {
        this.lastBytes = 0;
        this.lastPollTime = Date.now();
        this.statsTimer = setInterval(async () => {
            try {
                let total = 0;
                for (const name of this.sinkNames) {
                    const served = (await this.getElementProperty(name, 'bytes-served')) as number;
                    if (typeof served === 'number') total += served;
                }
                const now = Date.now();
                const elapsed = (now - this.lastPollTime) / 1000;
                const counterReset = total < this.lastBytes;
                const deltaBytes = counterReset ? 0 : total - this.lastBytes;
                const bitrateKbps =
                    elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0;
                this.lastBytes = total;
                this.lastPollTime = now;
                this.setStatusData('throughput', {
                    'Output Bitrate': `${bitrateKbps} kbps`,
                    'Total Bytes': `${(total / 1024 / 1024).toFixed(1)} MB`,
                });
            } catch {
                /* pipeline not running yet */
            }
        }, 2000);
    }
}

import {
    GstPluginBase,
    ENCODER_ELEMENTS,
    H264_PROFILES,
    ProbedEncoders,
    SPEED_PRESETS,
    ThroughputPoller,
    bitrateBadge,
    type CodecId,
    type H264Profile,
    type ImplId,
    type PipelineDescription,
    type SpeedPreset,
    type ThroughputSample,
} from '@media-router/engine';
import { buildPipeline, DEMUX_NAME } from './transcoderPipeline.js';
import { renditionSummary, throughputSection } from './transcoderStatus.js';
import {
    buildDynamicPorts,
    outputPortId,
    readRenditions,
    renditionLabel,
    type DynamicPort,
    type ImplChoice,
    type Rendition,
    type ResolvedEncode,
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
    /** Bus-egress tee names captured at build time (`busout_<port>`), one per rendition. */
    private sinkNames: string[] = [];
    /** Renditions captured at build time, index-aligned with `sinkNames`. */
    private renditions: Rendition[] = [];
    /**
     * Per-rendition throughput: one counter per udpsink. All-or-nothing read —
     * a partial read (idle / not yet playing) would misreport rates, so any
     * unavailable counter skips the whole tick.
     */
    private readonly throughput = new ThroughputPoller({
        getBytes: async () => {
            if (!this.running || this.sinkNames.length === 0) return undefined;
            const served = await Promise.all(
                this.sinkNames.map((name) => this.readBusSinkBytes(name)),
            );
            if (served.some((v) => typeof v !== 'number')) return undefined;
            return Object.fromEntries(this.sinkNames.map((name, i) => [name, served[i] as number]));
        },
        publish: (total, perSink) => this.publishThroughput(total, perSink),
    });

    /**
     * What this host can encode with — impls per codec plus hardware-scaler
     * availability, filled in by `initManifest`. Hardware scalers are probed
     * because a rendition on a hardware encoder impl gets its scale stage
     * offloaded to the matching scaler when it's installed. Starts as the
     * all-empty host so a build before/without probing fails cleanly rather
     * than naming an encoder that isn't there.
     */
    static probed: ProbedEncoders = ProbedEncoders.unprobed();

    static async initManifest(manifest: Record<string, any>): Promise<void> {
        TranscoderModule.probed = await ProbedEncoders.probe(ENCODER_ELEMENTS, {
            probeHwScalers: true,
        });
        TranscoderModule.probed.applyToManifest(manifest);
    }

    /** Exposed for tests. */
    static getAvailableImpls(): Record<CodecId, ImplId[]> {
        return TranscoderModule.probed.availability;
    }

    /** Exposed for tests — replaces the availability, keeping the probed scalers. */
    static setAvailableImpls(availability: Record<CodecId, ImplId[]>): void {
        TranscoderModule.probed = ProbedEncoders.forTest(
            availability,
            TranscoderModule.probed.hwScalers,
        );
    }

    /** Exposed for tests — replaces the scalers, keeping the availability. */
    static setHwScalers(hwScalers: { va: boolean; v4l2: boolean }): void {
        TranscoderModule.probed = ProbedEncoders.forTest(
            TranscoderModule.probed.availability,
            hwScalers,
        );
    }

    /** One MPEG-TS input + one MPEG-TS output per configured rendition. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readRenditions(config));
    }

    async onStart(): Promise<void> {
        // super.onStart() invokes buildPipeline, which populates the input /
        // encoder status sections and captures sinkNames/renditions.
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

        const upstream = router.getModuleBusSource(instanceId);
        if (!upstream) {
            this.setHealth('warning', 'No upstream MPEG-TS source connected');
            return null;
        }

        const renditions = readRenditions(config);
        if (renditions.length === 0) {
            this.setHealth('warning', 'No renditions configured — add at least one output');
            return null;
        }

        // Module-global encoder defaults. Each is validated against its known set
        // so a malformed config can't splice an arbitrary token into the
        // gst-launch string; they also serve as the inherit-fallback for any
        // rendition that doesn't override the field.
        const globalCodec = (config.codec as CodecId) ?? 'h264';
        const globalImplChoice = (config.encoderImpl as ImplChoice) ?? 'auto';
        const globalRateControl = config.rateControl === 'vbr' ? 'vbr' : 'cbr';
        const globalSpeedPreset = SPEED_PRESETS.includes(config.speedPreset as SpeedPreset)
            ? (config.speedPreset as SpeedPreset)
            : 'ultrafast';
        const globalH264Profile = H264_PROFILES.includes(config.h264Profile as H264Profile)
            ? (config.h264Profile as H264Profile)
            : 'auto';
        // Clamp the scene-cut threshold to x264's valid 0–100 range (0 = off).
        const rawSceneCut = Math.round(Number(config.sceneCut));
        const globalSceneCut = Number.isFinite(rawSceneCut)
            ? Math.min(100, Math.max(0, rawSceneCut))
            : 40;
        // HRD/CPB depth (seconds of the rate cap). Bounds worst-case bursts —
        // above all scene-cut keyframes — so a fixed-rate link can deliver
        // every frame near its deadline. 1 s = classic vbv-bufsize default;
        // lower it when the delivery path has little headroom over the
        // stream rate (measured: 0.4 s keeps a 5 Mbps 1080p50 rendition's
        // IDRs deliverable over a ~2x-headroom RIST path).
        const rawCpb = Number(config.cpbSeconds);
        const globalCpbSeconds = Number.isFinite(rawCpb) ? Math.min(2, Math.max(0.1, rawCpb)) : 1;

        // Resolve each rendition's effective encoder settings (override ??
        // global) and its concrete impl. The impl is resolved PER rendition
        // against the rendition's (possibly overridden) codec — an inherited
        // encoderImpl choice like 'auto' must re-pick for that codec, not reuse
        // the global codec's resolved impl.
        const outputs: TranscoderOutput[] = [];
        for (let i = 0; i < renditions.length; i++) {
            const r = renditions[i];
            const codec = r.codec ?? globalCodec;
            const implChoice = r.encoderImpl ?? globalImplChoice;
            const impl = TranscoderModule.probed.resolve(codec, implChoice);
            if (!impl) {
                this.setHealth(
                    'error',
                    `No ${codec} encoder available for rendition "${renditionLabel(r)}" — install a compatible GStreamer plugin`,
                );
                return null;
            }
            const encode: ResolvedEncode = {
                codec,
                impl,
                rateControl: r.rateControl ?? globalRateControl,
                speedPreset: r.speedPreset ?? globalSpeedPreset,
                h264Profile: r.h264Profile ?? globalH264Profile,
                sceneCut: r.sceneCut ?? globalSceneCut,
                cpbSeconds: r.cpbSeconds ?? globalCpbSeconds,
            };
            const portId = outputPortId(i);
            const ep = router.assignBusChannel(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, port: ep.port, rendition: r, encode });
        }

        const framerate = (config.framerate as number) ?? 50;
        const gopFrames = (config.gopFrames as number) ?? 50;
        const bufferMs = (config.bufferMs as number) ?? 200;
        const decodeThreads = config.cpuDecodeThreading === 'single' ? 'single' : 'multi';
        // Validated against the known set like the encoder enums above, so a
        // malformed config can't splice into the gst-launch string.
        const deinterlace =
            config.deinterlace === 'force' || config.deinterlace === 'off'
                ? config.deinterlace
                : 'auto';
        const result = buildPipeline({
            input: { port: upstream.port, socketPath: upstream.socketPath },
            outputs,
            framerate,
            gopFrames,
            bufferMs,
            decodeThreads,
            deinterlace,
            hwScalers: TranscoderModule.probed.hwScalers,
        });
        if (!result) return null;

        this.sinkNames = result.sinkNames;
        this.renditions = renditions;
        this.setStatusData('input', { channel: upstream.port });
        // Headline codec/impl reflect what actually runs: the shared value when
        // every rendition resolves to the same one, else 'mixed'. Per-rendition
        // overrides are flagged inline in the renditions summary. (Derived from
        // outputs so the headline never names a codec/impl no rendition uses —
        // e.g. when the global codec has no encoder but all renditions override.)
        const codecs = new Set(outputs.map((o) => o.encode.codec));
        const impls = new Set(outputs.map((o) => o.encode.impl));
        this.setStatusData('encoder', {
            codec: codecs.size === 1 ? [...codecs][0] : 'mixed',
            impl: impls.size === 1 ? [...impls][0] : 'mixed',
            framerate: `${framerate} fps`,
            renditions: renditionSummary(outputs),
        });
        this.setHealth('ok');

        // Decode threading is set INLINE in the pipeline (explicit
        // `avdec_h264 thread-type=frame`, see buildPipeline) rather than left to
        // the engine runner's decoder auto-plug hook, which does not reliably
        // apply it.
        return {
            pipeline: result.pipeline,
            restartOnError: true,
            // Restart-proof lipsync (default on): output PES PTS/PCR carry the
            // SOURCE timeline instead of a fresh per-incarnation rebase, so
            // downstream muxers align this video with its sibling audio by real
            // PTS. `preserveSourceTimeline: false` in settings is the per-module
            // rollback (x-advanced). LEGACY PATH ONLY — under the time-sync
            // contract the engine drops this (GstPluginBase.applyTimeSync): the
            // producer-stamped egress supersedes it, and its restart-to-re-latch
            // answer to a discontinuity would pre-empt the contract's in-place
            // re-anchor.
            ...(config.preserveSourceTimeline === false
                ? {}
                : { preserveSourceTimeline: { demux: DEMUX_NAME } }),
        };
    }

    // --- internals ---

    /**
     * Publish a PER-RENDITION live bitrate (not a single aggregate) as a
     * runtime status section — one row per quality plus a Total. The face
     * badge stays the aggregate so the node shows one headline number.
     */
    private publishThroughput(
        total: ThroughputSample,
        perSink: Record<string, ThroughputSample>,
    ): void {
        const { fields, data } = throughputSection(this.sinkNames, this.renditions, total, perSink);
        this.dynamicStatusSections = [{ id: 'throughput', label: 'Live Throughput', fields }];
        this.setStatusData('throughput', data);
        this.setBadge('bitrate', bitrateBadge(total.bitrateKbps));
    }
}

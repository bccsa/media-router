import {
    GstPluginBase,
    ENCODER_ELEMENTS,
    H264_PROFILES,
    SPEED_PRESETS,
    bitrateBadge,
    resolveImpl,
    probeEncoderAvailability,
    applyEncoderAvailabilityToManifest,
    type CodecId,
    type H264Profile,
    type ImplId,
    type PipelineDescription,
    type SpeedPreset,
} from '@media-router/engine';
import { buildPipeline } from './transcoderPipeline.js';
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
    /** udpsink element names captured at build time (`usink_0`…), one per rendition. */
    private sinkNames: string[] = [];
    /** Renditions captured at build time, index-aligned with `sinkNames`. */
    private renditions: Rendition[] = [];
    /** Per-sink byte/time baseline for the per-rendition bitrate delta. */
    private sinkStats: Array<{ lastBytes: number; lastTime: number }> = [];
    /** Per-rendition throughput poll timer. */
    private statsTimer: ReturnType<typeof setInterval> | null = null;

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
        // encoder status sections and captures sinkNames/renditions.
        await super.onStart();
        this.sinkStats = this.sinkNames.map(() => ({ lastBytes: 0, lastTime: Date.now() }));
        this.statsTimer = setInterval(() => void this.pollThroughput(), 2000);
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
            const impl = resolveImpl(codec, implChoice, TranscoderModule.availableImpls[codec] ?? []);
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
            };
            const portId = outputPortId(i);
            const ep = router.assignUdpPort(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, host: ep.host, port: ep.port, rendition: r, encode });
        }

        const framerate = (config.framerate as number) ?? 50;
        const gopFrames = (config.gopFrames as number) ?? 50;
        const bufferMs = (config.bufferMs as number) ?? 200;
        const decodeThreads = config.cpuDecodeThreading === 'single' ? 'single' : 'multi';
        const result = buildPipeline({
            input: { host: upstream.host, port: upstream.port },
            outputs,
            framerate,
            gopFrames,
            bufferMs,
            decodeThreads,
            timeoutNs: 5_000_000_000,
        });
        if (!result) return null;

        this.sinkNames = result.sinkNames;
        this.renditions = renditions;
        this.setStatusData('input', { host: upstream.host, port: upstream.port });
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
            renditions: this.renditionSummary(outputs),
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

    private renditionSummary(outputs: TranscoderOutput[]): string {
        return outputs
            .map((o) => {
                const r = o.rendition;
                // Flag only the knobs this rendition actually overrides, using the
                // resolved value so 'auto'/inherited entries don't show noise.
                const tags: string[] = [];
                if (r.codec) tags.push(o.encode.codec);
                if (r.encoderImpl) tags.push(o.encode.impl);
                if (r.rateControl) tags.push(o.encode.rateControl);
                if (r.speedPreset) tags.push(o.encode.speedPreset);
                if (r.h264Profile && r.h264Profile !== 'auto') tags.push(o.encode.h264Profile);
                if (r.sceneCut !== undefined) tags.push(`sc${o.encode.sceneCut}`);
                const suffix = tags.length ? ` [${tags.join(', ')}]` : '';
                return `${r.width}x${r.height}@${r.bitrate}k${suffix}`;
            })
            .join(', ');
    }

    /**
     * Label for a per-rendition throughput row, e.g. `1280x720 @ 2500k`. Named
     * distinctly from `transcoderPorts.renditionLabel` (which returns the
     * operator-facing output name) — same family, different output.
     */
    private renditionStatLabel(r: Rendition | undefined, i: number): string {
        return r ? `${r.width}x${r.height} @ ${r.bitrate}k` : `Rendition ${i + 1}`;
    }

    /**
     * Poll every rendition's udpsink `bytes-served` and publish a PER-RENDITION
     * live bitrate (not a single aggregate) as a runtime status section — one
     * row per quality plus a Total. The face badge stays the aggregate so the
     * node shows one headline number.
     *
     * Skips the whole tick if any counter is unavailable (idle / not yet
     * playing) — a partial read would misreport rates. Each sink carries its own
     * byte/time baseline; a counter dropping below its last value is a child
     * re-spawn, treated as a fresh baseline (0 this tick) rather than a negative
     * rate.
     */
    private async pollThroughput(): Promise<void> {
        if (!this.running || this.sinkNames.length === 0) return;
        const served = await Promise.all(
            this.sinkNames.map((name) => this.getElementProperty(name, 'bytes-served')),
        );
        if (served.some((v) => typeof v !== 'number')) return;

        const now = Date.now();
        const fields: Array<{ key: string; label: string; unit?: string }> = [];
        const data: Record<string, number | string> = {};
        let totalMbps = 0;
        let totalBytes = 0;

        for (let i = 0; i < this.sinkNames.length; i++) {
            const bytes = served[i] as number;
            const st = this.sinkStats[i] ?? { lastBytes: 0, lastTime: now };
            const elapsed = (now - st.lastTime) / 1000;
            const reset = bytes < st.lastBytes;
            const delta = reset ? 0 : bytes - st.lastBytes;
            const mbps = elapsed > 0 ? (delta * 8) / elapsed / 1_000_000 : 0;
            st.lastBytes = bytes;
            st.lastTime = now;
            this.sinkStats[i] = st;

            totalMbps += mbps;
            totalBytes += bytes;
            fields.push({
                key: `r${i}`,
                label: this.renditionStatLabel(this.renditions[i], i),
                unit: 'Mbps',
            });
            data[`r${i}`] = Math.round(mbps * 100) / 100;
        }

        fields.push({ key: 'total', label: 'Total', unit: 'Mbps' });
        data.total = Math.round(totalMbps * 100) / 100;
        fields.push({ key: 'totalBytes', label: 'Total Bytes' });
        data.totalBytes = `${(totalBytes / 1024 / 1024).toFixed(1)} MB`;

        this.dynamicStatusSections = [{ id: 'throughput', label: 'Live Throughput', fields }];
        this.setStatusData('throughput', data);
        this.setBadge('bitrate', bitrateBadge(Math.round(totalMbps * 1000)));
    }
}

import {
    GstPluginBase,
    ThroughputPoller,
    bitrateBadge,
    probe302mSupport,
    probeMpegTsStream,
    type PipelineDescription,
    type ProbeResult,
    type ThroughputSample,
} from '@media-router/engine';
import { buildPipeline } from './audioTranscoderPipeline.js';
import {
    INPUT_PORT_ID,
    buildDynamicPorts,
    outputPortId,
    readRenditions,
    renditionLabel,
    type AudioTranscoderOutput,
    type DynamicPort,
    type Rendition,
} from './audioTranscoderPorts.js';

/**
 * Audio Transcoder plugin (decode-once → N renditions).
 *
 * ONE input port, ONE source (`maxConnections: 1`) — any TS-family stream;
 * the start-time probe picks the decoder chain (Opus/AAC/MP2/AC-3/302M/…).
 * A connection channel map is inlined as a `mix-matrix` on the trunk — no
 * mixer element, no added latency. Summing several sources is the separate
 * audio-mixer plugin's job (wire it in front of this module).
 *
 * The decoded audio feeds the shared re-encode: several renditions (Opus,
 * AAC, PCM 302M), each on its own output port.
 *
 * TIMELINE-TRUE BY DESIGN: the whole path lives in one GStreamer pipeline,
 * so the source PTS flow through decode → encode unchanged. This replaces
 * the audio-decoder → PipeWire → audio-encoder chain, whose capture-side
 * re-stamping turned its 290–330 ms loop dwell into audio-late A/V skew at
 * downstream muxers (plus a per-restart anchor lottery). No PipeWire, no
 * null-sink, no pactl anywhere in this module — VU comes from the in-pipeline
 * `level` element, volume from the gst `volume` element.
 *
 * Requires gst ≥ 1.26 for PCM-302M renditions (mpegtsmux must accept
 * `audio/x-smpte-302m` caps) — probed at load; older runtimes get a health
 * error only when a pcm rendition is actually configured.
 */
export class AudioTranscoderModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    /** Probed input stream info (null while nothing is wired). */
    private probeResult: ProbeResult | null = null;
    /** Sink counter names captured at build time, with their rendition index. */
    private sinks: Array<{ sinkName: string; renditionIndex: number }> = [];
    private renditions: Rendition[] = [];

    /** gst runtime support for 302M-in-TS, probed once at plugin load. */
    private static s302mSupported = false;

    static async initManifest(_manifest: Record<string, any>): Promise<void> {
        AudioTranscoderModule.s302mSupported = await probe302mSupport();
    }

    /** Exposed for tests. */
    static setS302mSupported(v: boolean): void {
        AudioTranscoderModule.s302mSupported = v;
    }

    private readonly throughput = new ThroughputPoller({
        getBytes: async () => {
            if (!this.running || this.sinks.length === 0) return undefined;
            const served = await Promise.all(
                this.sinks.map((s) => this.readBusSinkBytes(s.sinkName)),
            );
            if (served.some((v) => typeof v !== 'number')) return undefined;
            return Object.fromEntries(
                this.sinks.map((s, i) => [s.sinkName, served[i] as number]),
            );
        },
        publish: (total, perSink) => this.publishThroughput(total, perSink),
    });

    /** Two fixed inputs + one output per configured rendition. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readRenditions(config));
    }

    async onStart(): Promise<void> {
        // Probe the input's codec before the pipeline builds (the decoder
        // chain depends on it). Always probed — even a 302M-declared source —
        // to keep one uniform flow; the probe detects s302m like any codec.
        const source = this.inputSource();
        if (source) {
            this.probeResult = await probeMpegTsStream(source.port, 3000, source.socketPath);
            this.log.info({ codec: this.probeResult.codec }, 'Stream probe');
        } else {
            this.probeResult = null;
        }
        await super.onStart();
        this.throughput.start();
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
        this.probeResult = null;
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const renditions = readRenditions(config);
        if (renditions.length === 0) {
            this.setHealth('warning', 'No renditions configured — add at least one output');
            return null;
        }
        if (
            renditions.some((r) => r.codec === 'pcm') &&
            !AudioTranscoderModule.s302mSupported
        ) {
            this.setHealth(
                'error',
                'PCM 302M renditions need GStreamer ≥ 1.26 (mpegtsmux without audio/x-smpte-302m support detected)',
            );
            return null;
        }

        const source = this.inputSource();
        if (!source) {
            this.setHealth('warning', 'No input connected — wire an audio source to Audio In');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const channels = (config.channels as number) ?? 2;
        const tsAlignment = (config.tsAlignment as number) ?? 7;

        const outputs: AudioTranscoderOutput[] = [];
        for (let i = 0; i < renditions.length; i++) {
            const portId = outputPortId(i);
            const ep = router.assignBusChannel(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ portId, port: ep.port, rendition: renditions[i] });
        }

        const result = buildPipeline({
            source: {
                port: source.port,
                socketPath: source.socketPath,
                probedCodec: this.probeResult?.codec,
                bufferMs: Number(config.bufferMs ?? 75),
                channelMap: source.channelMap,
                // Matrix input dimension from the probe — a 5.1 source with a
                // stereo-pinned matrix would fail caps negotiation.
                sourceChannels: this.probeResult?.channels,
            },
            outputs,
            channels,
            volume: volumePct / 100,
            tsAlignment,
        });
        if (!result) return null;

        this.sinks = result.sinks;
        this.renditions = renditions;
        this.setStatusData('input', {
            mode: this.probeResult?.codec ?? 'auto',
        });
        this.setStatusData('encoder', {
            renditions: renditions.map((r) => renditionLabel(r)).join(', '),
        });
        if (!this.probeResult || this.probeResult.codec === 'unknown') {
            // Probe saw no audio (source still starting?) — decodebin fallback
            // is degraded and stays until the next restart re-probes. Surface
            // it instead of a silent 'ok'.
            this.setHealth(
                'warning',
                'Source codec unknown — using generic decoder; restart module to re-probe once the source is live',
            );
        } else {
            this.setHealth('ok');
        }

        return {
            pipeline: result.pipeline,
            restartOnError: true,
        };
    }

    // --- internals ---

    /** The single bus source wired to the input port (cap 1), if any. */
    private inputSource() {
        const instanceId = this.services?.instanceId ?? '';
        return (this.services?.mediaRouter?.getModuleBusSources(instanceId) ?? []).find(
            (s: { sinkPortId: string }) => s.sinkPortId === INPUT_PORT_ID,
        );
    }

    private publishThroughput(
        total: ThroughputSample,
        perSink: Record<string, ThroughputSample>,
    ): void {
        const fields: Array<{ key: string; label: string; unit?: string }> = [];
        const data: Record<string, number | string> = {};
        for (const s of this.sinks) {
            const sample = perSink[s.sinkName];
            if (!sample) continue;
            const r = this.renditions[s.renditionIndex];
            fields.push({
                key: `r${s.renditionIndex}`,
                label: r ? renditionLabel(r) : `Rendition ${s.renditionIndex + 1}`,
                unit: 'kbps',
            });
            data[`r${s.renditionIndex}`] = sample.bitrateKbps;
        }
        fields.push({ key: 'total', label: 'Total', unit: 'kbps' });
        data.total = total.bitrateKbps;
        this.dynamicStatusSections = [{ id: 'throughput', label: 'Live Throughput', fields }];
        this.setStatusData('throughput', data);
        this.setBadge('bitrate', bitrateBadge(total.bitrateKbps));
    }
}

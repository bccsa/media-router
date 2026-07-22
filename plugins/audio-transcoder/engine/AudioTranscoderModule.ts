import {
    GstPluginBase,
    ThroughputPoller,
    bitrateBadge,
    gstElementSupportsCaps,
    probeGstElement,
    probeMpegTsStream,
    type PipelineDescription,
    type ProbeResult,
    type ThroughputSample,
} from '@media-router/engine';
import { buildPipeline } from './audioTranscoderPipeline.js';
import {
    AUDIO_INPUT_PORT_ID,
    MPEGTS_INPUT_PORT_ID,
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
 * One audio source in — MPEG-TS (any supported codec, decoded once) or an
 * N-way 302M PCM mix input — re-encoded into several renditions (Opus, AAC,
 * PCM 302M), each on its own output port.
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

    /** Probed mpegts-in stream info (null on the mix front-end). */
    private probeResult: ProbeResult | null = null;
    /** Sink counter names captured at build time, with their rendition index. */
    private sinks: Array<{ sinkName: string; renditionIndex: number }> = [];
    private renditions: Rendition[] = [];

    /** gst runtime support for 302M-in-TS, probed once at plugin load. */
    private static s302mSupported = false;

    static async initManifest(_manifest: Record<string, any>): Promise<void> {
        const [enc, mux] = await Promise.all([
            probeGstElement('avenc_s302m'),
            gstElementSupportsCaps('mpegtsmux', 'audio/x-smpte-302m'),
        ]);
        AudioTranscoderModule.s302mSupported = enc && mux;
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
        // Probe the mpegts input's codec before the pipeline builds (the
        // decoder chain depends on it). Mix front-end needs no probe — its
        // content is 302M by contract.
        const instanceId = this.services?.instanceId ?? '';
        const upstream = this.services?.mediaRouter?.getModuleBusSource(
            instanceId,
            MPEGTS_INPUT_PORT_ID,
        );
        if (upstream) {
            this.probeResult = await probeMpegTsStream(
                upstream.port,
                3000,
                upstream.socketPath,
            );
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
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => {
                this.log.debug({ err }, 'Volume update failed (pipeline may not be running)');
            });
        }
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

        // Front-end selection: mpegts-in wins when both inputs are wired.
        const mpegtsSrc = router.getModuleBusSource(instanceId, MPEGTS_INPUT_PORT_ID);
        const mixSources = router
            .getModuleBusSources(instanceId)
            .filter((s) => s.sinkPortId === AUDIO_INPUT_PORT_ID);
        if (!mpegtsSrc && mixSources.length === 0) {
            this.setHealth('warning', 'No input connected — wire MPEG-TS In or Audio In (302M)');
            return null;
        }
        if (mpegtsSrc && mixSources.length > 0) {
            this.setHealth('warning', 'Both inputs wired — Audio In (302M) is ignored while MPEG-TS In is connected');
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
            frontEnd: mpegtsSrc
                ? {
                      mode: 'mpegts',
                      port: mpegtsSrc.port,
                      socketPath: mpegtsSrc.socketPath,
                      probedCodec: this.probeResult?.codec,
                      bufferMs: Number(config.bufferMs ?? 75),
                  }
                : {
                      mode: 'mix',
                      sources: mixSources,
                      latencyMs: Number(config.mixLatencyMs ?? 200),
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
            mode: mpegtsSrc
                ? `MPEG-TS (${this.probeResult?.codec ?? 'auto'})`
                : `302M mix (${mixSources.length} source${mixSources.length === 1 ? '' : 's'})`,
        });
        this.setStatusData('encoder', {
            renditions: renditions.map((r) => renditionLabel(r)).join(', '),
        });
        if (!(mpegtsSrc && mixSources.length > 0)) this.setHealth('ok');

        return {
            pipeline: result.pipeline,
            restartOnError: true,
        };
    }

    // --- internals ---

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

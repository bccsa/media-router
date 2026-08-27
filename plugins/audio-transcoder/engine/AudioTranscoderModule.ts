import {
    GstPluginBase,
    ThroughputPoller,
    bitrateBadge,
    probeMpegTsStream,
    type PipelineDescription,
    type ProbeResult,
    type ThroughputSample,
} from '@media-router/engine';
import { probe302mSupport } from '@media-router/plugin-audio-302m-core';
import { buildPipeline, DEMUX_NAME } from './audioTranscoderPipeline.js';
import { CoalescedRestart } from './coalescedRestart.js';
import { FALLBACK_DECODER_WARNING, ReprobeLoop } from './reprobeLoop.js';
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

    /** Self-heal for a start-time probe that saw nothing — see `reprobeLoop.ts`. */
    private readonly reprobe = new ReprobeLoop({
        probe: () => this.probeInput(),
        degraded: () => this.setHealth('warning', FALLBACK_DECODER_WARNING),
        restart: (result) => {
            this.log.info({ codec: result.codec }, 'Source identified — rebuilding decoder chain');
            return this.restartPipeline();
        },
    });

    /** Restart cycle in flight + ONE queued follow-up — see `coalescedRestart.ts`. */
    private readonly pipelineRestart = new CoalescedRestart({
        cycle: () => this.restartCycle(),
        onError: (err) => this.handleRestartCycleFailure(err),
    });

    /**
     * One-shot token, set immediately before a restart cycle calls THIS
     * module's own `onStop` and consumed at `onStop`'s entry. Any other entry
     * into `onStop` is therefore an external (engine/user) stop — see
     * `externalStop`.
     */
    private selfRestarting = false;
    /**
     * An external stop has landed and no external start has followed. Latched
     * because a stop can arrive in the middle of a restart cycle, after the
     * cycle's fallback guard has already passed: without the latch the cycle's
     * `onStart` revived a module the engine had just stopped.
     */
    private externalStop = false;

    /** Two fixed inputs + one output per configured rendition. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(readRenditions(config));
    }

    async onStart(): Promise<void> {
        // A start clears the external-stop latch: whatever stopped this module
        // has been answered, so an ordinary stop→start behaves like a first
        // start (including re-arming the self-heal below).
        this.externalStop = false;
        // Probe the input's codec before the pipeline builds (the decoder
        // chain depends on it). Always probed — even a 302M-declared source —
        // to keep one uniform flow; the probe detects s302m like any codec.
        this.probeResult = await this.probeInput();
        if (this.probeResult) this.log.info({ codec: this.probeResult.codec }, 'Stream probe');
        await super.onStart();
        this.throughput.start();
        // A probe that saw nothing (upstream not producing yet) built the
        // decodebin fallback — keep re-probing until the source identifies
        // itself instead of waiting for a human to restart the module.
        // Re-checks the latch: a stop that landed during the awaits above must
        // not leave a timer running on a module that is no longer up.
        if (!this.externalStop && this.usingFallbackDecoder()) this.reprobe.arm();
    }

    async onStop(): Promise<void> {
        // Consume the self-restart token: present only for the `onStop` a
        // restart cycle makes itself, so its absence marks an EXTERNAL stop.
        const selfInitiated = this.selfRestarting;
        this.selfRestarting = false;
        if (!selfInitiated) this.externalStop = true;
        this.reprobe.disarm();
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
            // Probe saw no audio (source still starting?) — the decodebin
            // fallback is degraded, and `reprobe` keeps re-probing until the
            // source identifies itself. Surface it instead of a silent 'ok'.
            this.setHealth('warning', FALLBACK_DECODER_WARNING);
        } else {
            this.setHealth('ok');
        }

        return {
            pipeline: result.pipeline,
            restartOnError: true,
            // Restart-proof lipsync (default on): shifts the demux branches onto
            // the SOURCE timeline, which also anchors the perfect-timestamp
            // encoders at source values — output PES PTS then match the source
            // and downstream muxers align by real PTS across restarts. LEGACY
            // PATH ONLY — the engine drops it under the time-sync contract
            // (GstPluginBase.applyTimeSync), which stamps the egress instead.
            ...(config.preserveSourceTimeline === false
                ? {}
                : { preserveSourceTimeline: { demux: DEMUX_NAME } }),
        };
    }

    // --- internals ---

    /** Overridable for tests — probes one input socket for its codec. */
    protected probeStream(port: number, socketPath?: string): Promise<ProbeResult> {
        return probeMpegTsStream(port, 3000, socketPath);
    }

    /** Probe the wired input, or `null` when nothing is wired. */
    private probeInput(): Promise<ProbeResult | null> {
        const source = this.inputSource();
        return source ? this.probeStream(source.port, source.socketPath) : Promise.resolve(null);
    }

    /** True while the running build is the degraded decodebin fallback: a wired
     *  source whose codec the probe could not identify. Mirrors the
     *  `buildPipeline` branch that raises `FALLBACK_DECODER_WARNING`. */
    private usingFallbackDecoder(): boolean {
        return !!this.inputSource() && (!this.probeResult || this.probeResult.codec === 'unknown');
    }

    /**
     * Stop/start so `onStart` re-probes and `buildPipeline` picks the
     * codec-specific chain. Coalesced (see `coalescedRestart.ts`): a trigger
     * landing mid-cycle queues ONE follow-up cycle, which re-runs against the
     * latest probe rather than being dropped.
     */
    private restartPipeline(): Promise<void> {
        return this.pipelineRestart.trigger();
    }

    /**
     * One restart cycle, with the two preconditions that make ADR-0009 rule 2
     * hold — both re-checked HERE rather than at the caller, so a queued
     * follow-up cycle gets them too:
     *
     * 1. FALLBACK ONLY. A transcoder restart drops this module's output socket
     *    and rebuilds its encoders, interrupting every downstream consumer
     *    (ADR-0005 rejects erroring a pipeline out to re-latch for exactly that
     *    cost), so a healthy known-codec pipeline is never bounced. This is
     *    what stops a second trigger bouncing the chain the first one fixed.
     * 2. NOT EXTERNALLY STOPPED. Re-checked immediately before `onStart`,
     *    because the engine can stop the module during our own `onStop` — after
     *    check 1 passed. Reviving it there would resurrect a module the user
     *    just disabled; the cycle aborts instead, and deliberately does NOT
     *    re-arm the re-probe loop (`onStop` disarmed it, and there is nothing
     *    to self-heal on a module that is meant to be down).
     */
    private async restartCycle(): Promise<void> {
        if (!this.usingFallbackDecoder()) return;
        this.selfRestarting = true;
        try {
            await this.onStop();
        } finally {
            // `onStop` consumes the token; clear it here too so a throw on the
            // way in can never leave a later external stop looking internal.
            this.selfRestarting = false;
        }
        if (this.externalStop) {
            this.log.info('Module stopped mid-restart — abandoning the re-probe restart');
            return;
        }
        await this.onStart();
    }

    /**
     * A restart cycle threw (a failing `onStop` is the field case: the throw
     * skipped `onStart`, leaving the module down).
     *
     * ADR-0009 rule 1 is unbounded by design, so ONE failed cycle must not end
     * the self-heal — the loop was disarmed to run this cycle, so re-arm it and
     * let the next tick retry. Not re-armed when the module has been stopped
     * from outside (nothing to heal) or is no longer on the fallback chain
     * (rule 2: a known-codec pipeline is never bounced).
     */
    private handleRestartCycleFailure(err: unknown): void {
        this.log.warn({ err }, 'Re-probe restart cycle failed');
        if (this.externalStop || !this.usingFallbackDecoder()) return;
        this.reprobe.arm();
    }

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

import { GstPluginBase, findLadspaElement, type PipelineDescription } from '@media-router/engine';
import { probe302mSupport, type AudioMixSource } from '@media-router/plugin-audio-302m-core';
import { buildProcessingPipeline } from './audioProcessingPipeline.js';
import {
    chainSummary,
    partitionBusSources,
    resolveChainStages,
    LIVE_PARAMS,
    OUTPUT_PORT,
} from './chainSetup.js';
import { ChainTelemetry } from './chainTelemetry.js';
import { DuckerEnvelope } from './duckerEnvelope.js';
import { GRAPH_SECTION } from './graphPublisher.js';
import { isLadspaDynMode } from './lspConfig.js';
import {
    resolveEqFanOut,
    resolveLiveTarget,
    type ChainStages,
    type DynamicsMode,
} from './lspProcessing.js';

/**
 * Audio Processing on the 302M bus — HPF → EQ → dynamics → limiter → ducker.
 *
 * The 302M successor to the PipeWire `audio-dynamics` plugin: same operator
 * knobs (compressor / gate / ducker parameters), plus a 6-band parametric EQ,
 * an expander, a high-pass filter and a brickwall limiter. Program and
 * sidechain are 302M bus inputs, the processed program leaves as 302M — so the
 * source PES PTS survives the whole chain (no null-sinks, no re-stamping).
 *
 * DSP is LSP LADSPA, resolved from the registry at start (`findLadspaElement`)
 * because the element names embed the library version. The compressor, gate and
 * expander are the SELF-keyed variants: a program dynamics stage needs no
 * external key, which removes the old module's 4-channel deinterleave→interleave
 * packing. `sc-gate-stereo` survives for exactly one case — a gate keyed off the
 * sidechain input.
 *
 * Ducking stays on the native `level`→`volume` control loop (exact floor,
 * independent attack/release/hold, zero added latency, no LADSPA at all).
 */
export class AudioProcessingModule extends GstPluginBase {
    protected liveUpdatableParams = LIVE_PARAMS;

    /** gst runtime support for 302M-in-TS, probed once at plugin load. */
    private static s302mSupported = false;

    static async initManifest(_manifest: Record<string, any>): Promise<void> {
        AudioProcessingModule.s302mSupported = await probe302mSupport();
    }

    /** Exposed for tests. */
    static setS302mSupported(v: boolean): void {
        AudioProcessingModule.s302mSupported = v;
    }

    /** Stages actually built into the running pipeline — null until onStart
     *  has resolved the LADSPA elements. */
    private stages: ChainStages | null = null;
    private sinkName: string | null = null;
    private readonly ducker = new DuckerEnvelope();

    /** Meter + throughput polls and the settings-panel graphs. */
    private readonly telemetry = new ChainTelemetry({
        readProperty: (element, prop) => this.getElementProperty(element, prop),
        readSinkBytes: async () => {
            if (!this.running || !this.sinkName) return undefined;
            const served = await this.readBusSinkBytes(this.sinkName);
            return typeof served === 'number' ? { [this.sinkName]: served } : undefined;
        },
        publishStatus: (section, data) => this.setStatusData(section, data),
        publishGraph: (key, graph) => this.setStatusGraph(GRAPH_SECTION, key, graph),
        badge: (id, badge) => (badge ? this.setBadge(id, badge) : this.clearBadge(id)),
        config: () => this.config,
    });

    private get mode(): DynamicsMode {
        const m = this.config.mode as string;
        return isLadspaDynMode(m) || m === 'ducker' ? m : 'none';
    }

    async onInit(
        config: Record<string, unknown>,
        services?: Parameters<GstPluginBase['onInit']>[1],
    ): Promise<void> {
        await super.onInit(config, services);
        // A stopped module still has a settings panel: publish the curves off
        // config so the graphs render before the chain ever runs.
        this.telemetry.publishGraphs();
    }

    /** Overridable for tests — resolves a LADSPA element from the registry. */
    protected resolveLadspa(suffix: string): Promise<string | null> {
        return findLadspaElement(suffix);
    }

    private partitionSources(): { program: AudioMixSource[]; sidechain: AudioMixSource[] } {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        return partitionBusSources(
            (router?.getModuleBusSources(instanceId) ?? []) as Array<
                AudioMixSource & { sinkPortId: string }
            >,
        );
    }

    private async requireLadspa(suffix: string): Promise<string> {
        const element = await this.resolveLadspa(suffix);
        if (!element) {
            throw new Error(
                `LADSPA element *-${suffix} not found — install lsp-plugins-ladspa ` +
                    `and the GStreamer ladspa wrapper (gst-plugins-bad)`,
            );
        }
        return element;
    }

    async onStart(): Promise<void> {
        // On a runtime without 302M the pipeline can't be built at all — skip
        // the LADSPA probe so the operator gets the 302M diagnosis, not a
        // confusing "install lsp-plugins" error from a stage that never runs.
        this.stages = AudioProcessingModule.s302mSupported
            ? await resolveChainStages(
                  this.config,
                  this.mode,
                  this.partitionSources().sidechain.length > 0,
                  (suffix) => this.requireLadspa(suffix),
              )
            : null;
        await super.onStart();
        this.telemetry.start(this.running ? this.stages : null);
    }

    async onStop(): Promise<void> {
        this.telemetry.stop();
        this.stages = null;
        this.sinkName = null;
        await super.onStop();
    }

    /**
     * Re-seed the ducker envelope on every PLAYING, including a crash-restart:
     * the engine's sticky-property replay restores the last written `duckvol`
     * value, which a fresh envelope (assuming unity) would never correct while
     * the key stays steady. LADSPA stages need nothing — the same sticky replay
     * restores their live properties.
     */
    protected onPipelinePlaying(): void {
        if (this.mode !== 'ducker') return;
        this.ducker.reset();
        void this.setElementProperty('duckvol', 'volume', 1);
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        // Before the stage guard: the graphs are drawn from config alone, so a
        // knob still moves the curve on a module that isn't running.
        this.telemetry.publishGraphs();
        const stages = this.stages;
        if (!stages) return; // ducker params are read live by the envelope

        for (const [key, value] of Object.entries(changes)) {
            const target = resolveLiveTarget(key, value, stages);
            if (target) {
                await this.setElementProperty(target.element, target.prop, target.value);
                continue;
            }
            for (const fanned of resolveEqFanOut(key, value, stages)) {
                await this.setElementProperty(fanned.element, fanned.prop, fanned.value);
            }
        }
    }

    /**
     * Sidechain level → gain envelope (ducker mode). Fires on the generic
     * `level:sclevel` channel (~15 ms); the envelope reads its parameters live
     * from config, and only returns a gain when it has actually moved, so a
     * steady (open or fully-ducked) state costs no IPC.
     */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (this.mode !== 'ducker' || channel !== 'level:sclevel') return;
        const rms = (payload as { rms?: number[] })?.rms;
        if (!rms?.length) return;
        const gain = this.ducker.advance(rms, this.config);
        if (gain !== null) void this.setElementProperty('duckvol', 'volume', gain);
        // Same tick drives the ducker graphs' live level (throttled in telemetry).
        this.telemetry.duckLevel(this.ducker);
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        if (!AudioProcessingModule.s302mSupported) {
            this.setHealth(
                'error',
                '302M audio processing needs GStreamer ≥ 1.26 (avenc_s302m or mpegtsmux without audio/x-smpte-302m support detected)',
            );
            return null;
        }
        if (!this.stages) return null; // elements not resolved yet (pre-start)

        const { program: programSources, sidechain: sidechainSources } = this.partitionSources();
        if (programSources.length === 0) {
            // Sidechain-only wiring lands here: a key is not programme audio,
            // so the module stays down and says what is missing.
            this.setHealth('warning', 'No sources connected — wire 302M audio to Program In');
            return null;
        }

        const ep = router.assignBusChannel(instanceId, OUTPUT_PORT);
        if (!ep) {
            this.setHealth('error', `UDP port pool exhausted while allocating ${OUTPUT_PORT}`);
            return null;
        }

        const result = buildProcessingPipeline({
            programSources,
            sidechainSources,
            outputPort: ep.port,
            latencyMs: Number(config.mixLatencyMs ?? 200),
            config,
            stages: this.stages,
        });
        if (!result) return null;

        this.sinkName = result.sinkName;
        const { data, health } = chainSummary(
            this.stages,
            this.config.gateKey,
            sidechainSources.length,
        );
        this.setStatusData('chain', data);
        this.telemetry.publishGraphs();
        if (health.message) this.setHealth(health.level, health.message);
        else this.setHealth(health.level);

        return {
            pipeline: result.pipeline,
            restartOnError: true,
            busReports: result.busReports,
        };
    }
}

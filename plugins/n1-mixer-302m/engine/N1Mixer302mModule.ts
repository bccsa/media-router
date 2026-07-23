import {
    GstPluginBase,
    probe302mSupport,
    type AudioMixSource,
    type PipelineDescription,
} from '@media-router/engine';
import {
    activeOutputIndices,
    buildN1Pipeline,
    buildN1Ports,
    n1PortId,
    readPairCount,
    type DynamicPort,
    type N1Output,
} from './n1Mixer302mPipeline.js';

/**
 * N-1 Mix-Minus Audio Mixer on the 302M bus.
 *
 * N input/output pairs where each output carries a mix of ALL inputs EXCEPT
 * the one at the same index — broadcast IFB: each presenter hears everyone
 * but themselves. The GStreamer `audiomixer` sums by running time, so
 * same-timeline inputs mix content-aligned and outputs carry coherent PTS —
 * replacing the PipeWire n1-mixer's arrival-time summing (and its re-stamped
 * loop dwell). No PipeWire anywhere in this module.
 *
 * One pipeline for the whole matrix: any input wiring change restarts it,
 * blipping all outputs (inherent to the one-pipeline model — same contract
 * as audio-output-302m gaining a source).
 */
export class N1Mixer302mModule extends GstPluginBase {
    protected liveUpdatableParams: string[] = [];

    /** gst runtime support for 302M-in-TS, probed once at plugin load. */
    private static s302mSupported = false;

    static async initManifest(_manifest: Record<string, any>): Promise<void> {
        N1Mixer302mModule.s302mSupported = await probe302mSupport();
    }

    /** Exposed for tests. */
    static setS302mSupported(v: boolean): void {
        N1Mixer302mModule.s302mSupported = v;
    }

    /** N in + N out ports from the passed config — ports resolve BEFORE the
     *  module starts, when `this.config` is still empty. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildN1Ports(readPairCount(config));
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        if (!N1Mixer302mModule.s302mSupported) {
            this.setHealth(
                'error',
                '302M mixing needs GStreamer ≥ 1.26 (avenc_s302m or mpegtsmux without audio/x-smpte-302m support detected)',
            );
            return null;
        }

        const pairCount = readPairCount(config);

        // Group connected sources by input index; clamp guards stale edges in
        // the window after a pairCount shrink.
        const inputs = new Map<number, AudioMixSource[]>();
        for (const s of router.getModuleBusSources(instanceId)) {
            const m = /^in-(\d+)$/.exec(s.sinkPortId);
            if (!m) continue;
            const index = Number(m[1]);
            if (index >= pairCount) continue;
            const group = inputs.get(index) ?? [];
            group.push(s);
            inputs.set(index, group);
        }
        if (inputs.size === 0) {
            this.setHealth('warning', 'No 302M sources connected');
            return null;
        }

        const outputs: N1Output[] = [];
        for (const o of activeOutputIndices(inputs.keys(), pairCount)) {
            const portId = n1PortId('out', o);
            const ep = router.assignBusChannel(instanceId, portId);
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return null;
            }
            outputs.push({ index: o, port: ep.port });
        }

        const pipeline = buildN1Pipeline({
            inputs,
            outputs,
            latencyMs: Number(config.mixLatencyMs ?? 200),
        });
        if (!pipeline) return null;

        this.setStatusData('routing', {
            pairCount,
            connectedInputs: inputs.size,
            activeOutputs: outputs.length,
        });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
        };
    }
}

import {
    GstPluginBase,
    type AlignerInputRef,
    type AlignerWatchRef,
    type LiveInputBranch,
    type PipelineDescription,
} from '@media-router/engine';
import {
    normalize302mChannels,
    probe302mSupport,
    s302mFormatFor,
    type AudioMixSource,
} from '@media-router/plugin-audio-302m-core';
import {
    activeOutputIndices,
    buildN1Parts,
    buildN1Ports,
    n1InputBranch,
    n1PortId,
    readChannels,
    readPairCount,
    isMatrixAligner,
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
 * One pipeline for the whole matrix. A further source on an already-connected
 * input is added/removed live on that input's `inmix<i>` (`getLiveInputBranch`);
 * the first source on an input, or its last one leaving, still restarts the
 * pipeline (its tee, matrix links and active outputs change with it).
 */
export class N1Mixer302mModule extends GstPluginBase {
    protected liveUpdatableParams: string[] = [];

    /** A matrix link (`omix<o>_aw<i>`) is an internal stage: its pace counts, it names nothing;
     *  the fan-ins' watches name the edges (B-70). */
    protected alignerInputOf(watch: AlignerWatchRef): AlignerInputRef | undefined {
        return isMatrixAligner(watch.aligner) ? null : undefined;
    }

    /** Inputs with a fan-in (`inmix<i>`) in the pipeline its runner runs; a start sets them. */
    private launchedInputs = new Set<number>();

    /** Live input add/remove on `in-<i>` — see `n1InputBranch`. */
    getLiveInputBranch(sinkPortId: string, connectionId: string): LiveInputBranch | null {
        const m = /^in-(\d+)$/.exec(sinkPortId);
        if (!m) return null;
        const index = Number(m[1]);
        // The first source on an input has no fan-in to join: no branch, so the engine
        // restarts the mixer into one, which also takes the outputs that input feeds (B-196).
        if (index >= readPairCount(this.config) || !this.launchedInputs.has(index)) return null;
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;
        const mine = router
            .getModuleBusSources(instanceId)
            .find(
                (s: { sinkPortId: string; connectionId: string }) =>
                    s.sinkPortId === sinkPortId && s.connectionId === connectionId,
            );
        // Remove: the record is already gone — name the branch to take off
        // (the engine keeps the classic restart for the LAST one on a port).
        // Add: the branch for a running `inmix<i>`.
        return n1InputBranch(index, connectionId, mine, readChannels(this.config));
    }

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

    /** The 302M wire width every output encodes — consumers size their
     *  channel-map matrices from it. A mono mix goes out as dual-mono stereo. */
    getBusStreamChannels(portId: string): number | undefined {
        return /^out-\d+$/.test(portId)
            ? normalize302mChannels(readChannels(this.config))
            : undefined;
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        // With no runner yet this is a start's build, the pipeline that runs; a refresh has one.
        const launch = !this.childProcess;
        if (launch) this.launchedInputs = new Set();
        if (!router) return null;

        if (!N1Mixer302mModule.s302mSupported) {
            this.setHealth(
                'error',
                '302M mixing needs GStreamer ≥ 1.26 (avenc_s302m or mpegtsmux without audio/x-smpte-302m support detected)',
            );
            return null;
        }

        const pairCount = readPairCount(config);
        const channels = readChannels(config);

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

        const built = buildN1Parts({
            inputs,
            outputs,
            pcmFormat: s302mFormatFor(config.pcmBitDepth),
            channels,
        });
        if (!built) return null;
        if (launch) this.launchedInputs = new Set(inputs.keys());

        this.setStatusData('routing', {
            pairCount,
            channels,
            connectedInputs: inputs.size,
            activeOutputs: outputs.length,
        });
        this.setHealth('ok');

        return {
            pipeline: built.pipeline,
            liveInputs: built.liveInputs,
            restartOnError: true,
            // Audio-only bus producer: no decoder to drain, and the input
            // fan-ins' aligners hold every EOS (hold-on-eos), so the mix never
            // completes the EOS drain.
            eosDrain: false,
        };
    }
}

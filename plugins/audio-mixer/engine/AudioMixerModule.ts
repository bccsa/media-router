import {
    GstPluginBase,
    ThroughputPoller,
    bitrateBadge,
    type LiveInputBranch,
    type PipelineDescription,
    type ThroughputSample,
} from '@media-router/engine';
import { probe302mSupport, s302mFormatFor } from '@media-router/plugin-audio-302m-core';
import { buildMixerPipeline, mixerInputBranch } from './audioMixerPipeline.js';

const INPUT_PORT_ID = 'audio-in';
const OUTPUT_PORT_ID = 'audio-out';

/**
 * Audio Mixer on the 302M bus: sums every wired source into ONE 302M output.
 *
 * The plain-sum sibling of the N-1 mixer (which does mix-minus). Extracted
 * from the audio-transcoder's former mix front-end so each module does one
 * thing: this mixes, the transcoder transcodes — wire this in front of it
 * (or any 302M consumer) when several sources must be summed.
 *
 * Timeline-true: `audiomixer` aggregates by running time, so same-timeline
 * inputs mix content-aligned and the output carries coherent PTS. Input
 * wiring changes are live branch add/remove (`getLiveInputBranch`); only the
 * last input leaving idles the module. Per-connection channel maps give
 * per-source routing + gain; `volume` is the master fader (live, VU from `level`).
 */
export class AudioMixerModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    /** Live input add/remove for Audio In — see `mixerInputBranch`. */
    getLiveInputBranch(sinkPortId: string, connectionId: string): LiveInputBranch | null {
        if (sinkPortId !== INPUT_PORT_ID) return null;
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;
        const source = router
            .getModuleBusSources(instanceId)
            .find(
                (s: { sinkPortId: string; connectionId: string }) =>
                    s.sinkPortId === INPUT_PORT_ID && s.connectionId === connectionId,
            );
        return mixerInputBranch(connectionId, source, (this.config.channels as number) ?? 2);
    }

    private sinkName: string | null = null;

    /** gst runtime support for 302M-in-TS, probed once at plugin load. */
    private static s302mSupported = false;

    static async initManifest(_manifest: Record<string, any>): Promise<void> {
        AudioMixerModule.s302mSupported = await probe302mSupport();
    }

    /** Exposed for tests. */
    static setS302mSupported(v: boolean): void {
        AudioMixerModule.s302mSupported = v;
    }

    private readonly throughput = new ThroughputPoller({
        getBytes: async () => {
            if (!this.running || !this.sinkName) return undefined;
            const served = await this.readBusSinkBytes(this.sinkName);
            return typeof served === 'number' ? { [this.sinkName]: served } : undefined;
        },
        publish: (total: ThroughputSample) => {
            this.setStatusData('throughput', { bitrate: total.bitrateKbps });
            this.setBadge('bitrate', bitrateBadge(total.bitrateKbps));
        },
    });

    async onStart(): Promise<void> {
        await super.onStart();
        this.throughput.start();
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        if (!AudioMixerModule.s302mSupported) {
            this.setHealth(
                'error',
                '302M mixing needs GStreamer ≥ 1.26 (avenc_s302m or mpegtsmux without audio/x-smpte-302m support detected)',
            );
            return null;
        }

        const sources = router
            .getModuleBusSources(instanceId)
            .filter((s: { sinkPortId: string }) => s.sinkPortId === INPUT_PORT_ID);
        if (sources.length === 0) {
            this.setHealth('warning', 'No sources connected — wire 302M audio to Audio In');
            return null;
        }

        const ep = router.assignBusChannel(instanceId, OUTPUT_PORT_ID);
        if (!ep) {
            this.setHealth('error', `UDP port pool exhausted while allocating ${OUTPUT_PORT_ID}`);
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);

        const result = buildMixerPipeline({
            sources,
            outputPort: ep.port,
            channels: (config.channels as number) ?? 2,
            volume: volumePct / 100,
            latencyMs: Number(config.mixLatencyMs ?? 200),
            pcmFormat: s302mFormatFor(config.pcmBitDepth),
        });
        if (!result) return null;

        this.sinkName = result.sinkName;
        this.setStatusData('input', { sources: sources.length });
        this.setHealth('ok');

        return {
            pipeline: result.pipeline,
            restartOnError: true,
            // Audio-only bus producer: no decoder to drain, and a force-live
            // mix never completes the EOS drain — a stop would stall the 6 s
            // timeout and EOS every consumer first.
            eosDrain: false,
        };
    }
}

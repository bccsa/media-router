import {
    DECODE_BYPASS_PPM,
    GstPluginBase,
    backlogShedConfig,
    buildAsrc,
    buildLatenessTap,
    pulsePinnedStreamProps,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import { buildAudioMixInput, mixInputDemuxes } from '@media-router/plugin-audio-302m-core';
import { SINK_BUFFER_US, SLAVE_METHOD_CUSTOM, audio302mTsOffsetNs } from './audio302mTiming.js';
import { buildOutputPlacement } from './outputPlacement.js';

/** Answers LATENCY live (gstidentity.c: `live || sync`), so the sink adds its ring behind the
 *  non-live mixer arm too and one ts-offset holds in both arms; without it that arm plays about
 *  the ring early, or not at all at D = 60. Never waits: buffers come after their running time. */
const LIVE_UPSTREAM = 'identity name=live_upstream sync=true';
/** The output ASRC: the device term, with one source its decode term too (house-clock WI-P3-15). */
const OUT_ASRC = 'outasrc';

/**
 * Audio Output (302M) plugin.
 *
 * Plays SMPTE-302M PCM audio to an explicit physical device. Multiple
 * sources wired to the single input pin are mixed by the GStreamer
 * `audiomixer` — sample-accurate, timeline-aligned — replacing PipeWire's
 * arrival-time summing. PipeWire appears ONLY as the device sink layer
 * (`pulsesink device=…`); it is not a routing fabric here: no remap-sink,
 * no pw-links, no pactl volume.
 *
 * TIMING. Under the engine-wide time-sync contract (ADR-0005) this sink is a
 * presentation leg like the video-player's and the audio-decoder's: it
 * presents at `stamped-time + D` on the house clock — every input decodes on
 * content time (`mrtsdemux`, the formula demux), `sync=true`, `ts-offset`
 * = the route's playout offset (decision 4) plus the `lipSyncMs` trim,
 * `provide-clock=false`, `slave-method=custom` (below), `max-lateness=-1`
 * (a late timeline — mid-stream join, restart backlog — drains instead of
 * being dropped into silence, the same disarm the audio-decoder uses), and
 * the backlog shedder armed at `outasrc`'s input (below). Field, the Pi 5 test box,
 * 2026-09-03: with the video-player paced at stamp + D and this sink on
 * `sync=false`, audio played on arrival + whatever PipeWire and the queues
 * happened to hold — 50–200 ms EARLY, re-rolled on every restart. Two legs of
 * one route can only agree if both schedule off the same number.
 *
 * CLOCKS (house-clock part 4.4). A source on a clock of its own is resampled to house rate where
 * it is decoded; `outasrc` follows the device's clock through the sink's custom slaving, so the
 * sink never drops or repeats samples for drift. One resampler per path (OQ-23).
 *
 * CHANNEL PLACEMENT. `channels` is the mix width (1–8), `firstChannel` where
 * on the device it lands (X32 outputs 1–32 = four instances at 8 from
 * 1/9/17/25). `buildOutputPlacement` (outputPlacement.ts, ADR-0014) spreads a
 * non-default range onto the device's full width upstream of the sink; the
 * sink element and its timing properties are untouched by placement.
 *
 * - Volume/mute: gst `volume` element (single attenuation point).
 * - VU: in-pipeline `level` element (post-volume = what is being played;
 *   measures the N-channel mix, not the device-wide spread).
 * - Device hot-plug: base-class device watchdog stops/starts the pipeline.
 * - NEVER a default device (broadcast rule): unconfigured device = health
 *   error, no pipeline.
 */
export class AudioOutput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled', 'lipSyncMs'];

    private deviceName = '';
    /** The fan-in's demuxes and the connection each decodes, from the last build (WI-P3-6). */
    private demuxes = new Map<string, string>();

    /** A fan-in branch's demux serves its connection's row. */
    protected demuxInputOf(element: string): { connection: string } | undefined {
        const connection = this.demuxes.get(element);
        return connection ? { connection } : undefined;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';
    }

    async onStart(): Promise<void> {
        if (!this.deviceName) {
            throw new Error('No audio device configured');
        }
        // Device not enumerated yet → defer to the watchdog (throwing here
        // would prevent the watchdog from starting; hot-plug would then only
        // recover on an engine restart — same rationale as audio-output).
        if (this.services?.pipeWire && !this.services.pipeWire.hasDevice(this.deviceName)) {
            this.setHealth(
                'warning',
                `Audio device "${this.deviceName}" not connected — waiting for hot-plug`,
            );
            this.startDeviceWatchdog(false);
            return;
        }
        await super.onStart();
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
        await super.onStop();
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    /** Device unplugged — tear down the pipeline (pulsesink is gone). */
    protected async onDeviceDisconnected(): Promise<void> {
        try {
            await super.onStop();
        } catch {
            /* already stopped */
        }
    }

    /** Device returned — rebuild the pipeline. */
    protected async onDeviceReconnected(): Promise<void> {
        await super.onStart();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
        // `lipSyncMs` is a per-sink trim on top of the route's D — live for the
        // same reason the video-player's is: an operator trims it while
        // listening. (`applyVolumeLiveUpdate` has already merged `changes` into
        // `this.config`, which the push reads.)
        if ('lipSyncMs' in changes) await this.pushSinkTsOffset();
    }

    /**
     * The route head's playout offset D moved (ADR-0005 decision 4) — re-push
     * this leg's `ts-offset`. Called by `MediaRouter.notifyPlayoutOffsetChanged`
     * in the same pass as the video leg of the route, so the two never diverge.
     */
    async onRoutePlayoutOffsetChanged(): Promise<void> {
        await this.pushSinkTsOffset();
    }

    /** Push the resolved ts-offset to the running `pulsesink`. */
    private async pushSinkTsOffset(): Promise<void> {
        await this.setElementProperty(
            'sink',
            'ts-offset',
            audio302mTsOffsetNs(this.services, this.config),
        );
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const device = (config.device as string) ?? '';
        if (!device) {
            // Broadcast rule: never fall back to a default device.
            this.setHealth('error', 'No audio device configured');
            return null;
        }

        const sources = router
            .getModuleBusSources(instanceId)
            .filter((s) => s.sinkPortId === 'audio-in');
        if (sources.length === 0) {
            this.setHealth('warning', 'No 302M sources connected');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const channels = (config.channels as number) ?? 2;
        const firstChannel = Math.max(1, Math.trunc(Number(config.firstChannel ?? 1)) || 1);
        const deviceChannels = this.services?.pipeWire?.getDeviceInfo(device)?.channels ?? null;

        const placement = buildOutputPlacement({ device, channels, firstChannel, deviceChannels });
        if (placement.error !== undefined) {
            this.setHealth('error', placement.error);
            return null;
        }

        // One source: its branch leaves the decode term to outasrc, one resampler (OQ-23). A
        // mixer's branches each match their own source; outasrc is then the device term alone.
        const single = sources.length === 1;
        const mixIn = { sources, channels, branchAsrc: false };
        const { fragment, continuationName } = buildAudioMixInput(mixIn);
        this.demuxes = mixInputDemuxes(mixIn);
        const tsOffsetNs = audio302mTsOffsetNs(this.services, config);
        const outAsrc = buildAsrc({
            name: OUT_ASRC,
            deviceSink: 'sink',
            bypassBelowPpm: single ? DECODE_BYPASS_PPM : 0,
        });

        // Present at stamped time + D on the house clock (see the class comment). `name=sink` is
        // what the live offset push, the shedder's budget and outasrc address; audioconvert and
        // outasrc (no out-rate: the device's) let pulsesink negotiate the format and rate it wants.
        const sink =
            `pulsesink name=sink device=${device} sync=true provide-clock=false` +
            ` slave-method=${SLAVE_METHOD_CUSTOM} max-lateness=-1 buffer-time=${SINK_BUFFER_US}` +
            ` ts-offset=${tsOffsetNs} ${pulsePinnedStreamProps()}`;
        const chain = [
            `${continuationName}.`,
            LIVE_UPSTREAM,
            // Render lateness is read before outasrc, where PTS is still content time (part 4.4).
            buildLatenessTap('lat_render'),
            'audioconvert',
            outAsrc,
            `volume name=vol volume=${(volumePct / 100).toFixed(2)}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // Placement (if any) sits between the VU and the sink: the level meter
            // reads the mix, the sink receives the device-wide spread.
            placement.fragment,
            sink,
        ];
        const pipeline = `${fragment} ${chain.filter((e) => e).join(' ! ')}`;

        this.setStatusData('output', {
            device,
            sources: sources.length,
            channels,
            firstChannel,
            lastChannel: firstChannel - 1 + channels,
            ...(deviceChannels ? { deviceChannels } : {}),
            timing: 'house clock, playout offset',
            tsOffsetMs: Math.round(tsOffsetNs / 1_000_000),
        });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
            // Audio only, nothing to drain; and the mixer arm's aligners hold every EOS
            // (hold-on-eos), so a drain would wait out its 6 s timeout on each stop or rebuild.
            eosDrain: false,
            timingSink: { element: 'sink', kind: 'audio' },
            // The latency ratchet guard of this `sync=true` leg (backlogShed.ts), read and shed at
            // outasrc's input, the last pad on content time: after it the PTS run on the device's
            // clock (part 4.4). Whole PCM buffers, not keyframe-aligned; a click at most a minute.
            backlogShed: backlogShedConfig(this.services, {
                element: OUT_ASRC,
                sink: 'sink',
                keyframeAligned: false,
            }),
        };
    }
}

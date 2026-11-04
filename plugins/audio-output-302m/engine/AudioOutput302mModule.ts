import {
    CATCH_UP_EVENT,
    GstPluginBase,
    LAT_IN_PREFIX,
    PLAYOUT_WATCH_EVENT,
    backlogShedConfig,
    pulsePinnedStreamProps,
    readPlayoutWatch,
    withLatenessTap,
    type LiveInputBranch,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    buildAudioMixInput,
    buildLiveMixInput,
    liveInputBranchFor,
    type AudioMixSource,
} from '@media-router/plugin-audio-302m-core';
import {
    SINK_BUFFER_US,
    SLAVE_METHOD_SKEW,
    audio302mTsOffsetNs,
    seedsWithin,
} from './audio302mTiming.js';
import { launchCatchUpText } from './launchCatchUp.js';
import { buildOutputPlacement } from './outputPlacement.js';
import { SilentOutputWatch } from './silentOutputWatch.js';
import { TimelineSettleRestart } from './timelineSettleRestart.js';

/** Answers LATENCY live (gstidentity.c: `live || sync`), so the sink adds its ring behind the
 *  non-live mixer arm too and one ts-offset holds in both arms; without it that arm plays about
 *  the ring early, or not at all at D = 60. Never waits: buffers come after their running time. */
const LIVE_UPSTREAM = 'identity name=live_upstream sync=true';

const INPUT_PORT_ID = 'audio-in';
/** The fan-in's name prefix: `buildAudioMixInput`'s default, so one source keeps its string. */
const MIXER = 'mixin';

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
 * `provide-clock=false`, `slave-method=skew` (decision 5), `max-lateness=-1`
 * (a late timeline — mid-stream join, restart backlog — drains instead of
 * being dropped into silence, the same disarm the audio-decoder uses), and
 * the backlog shedder armed on the sink's own pad. Field, 10.9.16.103,
 * 2026-09-03: with the video-player paced at stamp + D and this sink on
 * `sync=false`, audio played on arrival + whatever PipeWire and the queues
 * happened to hold — 50–200 ms EARLY, re-rolled on every restart. Two legs of
 * one route can only agree if both schedule off the same number.
 *
 * CHANNEL PLACEMENT. `channels` is the mix width (1–8), `firstChannel` where
 * on the device it lands (X32 outputs 1–32 = four instances at 8 from
 * 1/9/17/25). `buildOutputPlacement` (outputPlacement.ts, ADR-0014) spreads a
 * non-default range onto the device's full width upstream of the sink; the
 * sink element and its timing properties are untouched by placement.
 *
 * SOURCES. From two, each is a live input (`liveInputs`, B-192): the runner starts with
 * those that run, the others join as they start, one that goes away costs its own input.
 * One source plays direct (ADR-0008 rule 3) and restarts with its wiring, as before.
 *
 * - Volume/mute: gst `volume` element (single attenuation point).
 * - VU: in-pipeline `level` element (post-volume = what is being played;
 *   measures the N-channel mix, not the device-wide spread).
 * - Device hot-plug: base-class device watchdog stops/starts the pipeline.
 * - A lost PipeWire stream (`sink` failed: PipeWire restarted or stopped) is rebuilt by that
 *   watchdog once PipeWire and the device are back, not restarted in a loop meanwhile (B-195).
 * - NEVER a default device (broadcast rule): unconfigured device = health
 *   error, no pipeline.
 * - Plays nothing (its mixer delivers no audio for 5 s, or the runner's playout watch sees every
 *   buffer miss the sink for 1 s): a warning, not ok; a stalled mixer is relaunched once (B-197,
 *   B-206). A launch skips what its inputs deliver from before it plays (B-206). A miss that a
 *   raise of its route did not change is how its sink plays, held, not silence (B-210).
 */
export class AudioOutput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled', 'lipSyncMs'];

    private deviceName = '';
    /** The device's channel count, read before each start: `buildPipeline` cannot wait (B-200). */
    private deviceChannels: number | null = null;
    /** The pipeline launched is the mixer arm (two sources or more), not the direct one. */
    private mixerLaunched = false;
    /** FF9: relaunch this pipeline once its source settles after a rebase or stall-resume. */
    private readonly settleRestart = new TimelineSettleRestart({
        pipeline: () => this.childProcess,
        log: () => this.log,
    });
    private readonly silent = new SilentOutputWatch({
        pipeline: () => this.childProcess,
        playing: () => this.childProcess?.isRunning === true,
        mixes: () => this.mixerLaunched,
        held: () => this.playoutHeld(),
        warn: (text) => {
            if (text === null || this.error !== text) this.setPlaysNothing(text);
        },
        log: () => this.log,
    });

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';
    }

    async onStart(): Promise<void> {
        if (!this.deviceName) {
            throw new Error('No audio device configured');
        }
        // Device not enumerated yet, or no answer from PipeWire → defer to the watchdog
        // (throwing here would prevent the watchdog from starting; hot-plug would then only
        // recover on an engine restart — same rationale as audio-output).
        if (await this.startWaitsForDevice(this.deviceName)) return;
        await this.readDeviceChannels();
        await super.onStart();
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        this.settleRestart.cancel();
        this.silent.stop();
        await this.stopDeviceWatchdog();
        await super.onStop();
    }

    async onDestroy(): Promise<void> {
        this.settleRestart.cancel();
        this.silent.stop();
        await super.onDestroy();
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        this.settleRestart.onPluginEvent(channel, payload);
        if (channel === PLAYOUT_WATCH_EVENT) this.onPlayoutWatch(payload);
        else if (channel === CATCH_UP_EVENT) this.logCatchUp(payload);
    }

    /** The runner's playout watch (B-206): on time again settles a raise first, so the warning
     *  "Plays nothing" stood over is not posted again when it withdraws. */
    private onPlayoutWatch(payload: unknown): void {
        const watch = readPlayoutWatch(payload);
        if (!watch) return;
        if (watch.playing) this.notePlayoutOnTime();
        this.silent.onPlayout(watch.playing, watch.lateMs);
    }

    /** One INFO line per launch that skipped its inputs' backlog (B-206). */
    private logCatchUp(payload: unknown): void {
        const router = this.services?.mediaRouter;
        const text = launchCatchUpText(payload, {
            sources: this.sources(),
            name: (id) => router?.moduleName?.(id) ?? id,
        });
        if (text) this.log.info({ catchUp: payload }, text);
    }

    /** Every reading feeds the stall-resume check: the time-sync contract is always on. */
    protected setVuData(data: number[]): void {
        super.setVuData(data);
        this.settleRestart.onVu(data);
        if (data.length) this.silent.onVu();
    }

    /** Every PLAYING is a fresh pipeline (no rebase pad offset): nothing left to relaunch. */
    protected onPipelinePlaying(): void {
        this.settleRestart.cancel();
        this.silent.onPlaying();
    }

    /** A held raise (B-210): the watch's miss is the sink's own pace, not "Plays nothing". */
    protected onPlayoutHeldChanged(): void {
        this.silent.refresh();
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    /** The 302M sources wired to Audio In. */
    private sources(): AudioMixSource[] {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return [];
        return router.getModuleBusSources(instanceId).filter((s) => s.sinkPortId === INPUT_PORT_ID);
    }

    /** Live input add, remove and join on Audio In, from two sources on: one plays direct, and
     *  a second wired to the direct pipeline restarts it into the mixer (B-194). */
    getLiveInputBranch(sinkPortId: string, connectionId: string): LiveInputBranch | null {
        if (sinkPortId !== INPUT_PORT_ID || !this.mixerLaunched) return null;
        const sources = this.sources();
        if (sources.length < 2) return null;
        const source = sources.find((s) => s.connectionId === connectionId);
        return liveInputBranchFor(MIXER, connectionId, source, {
            channels: (this.config.channels as number) ?? 2,
        });
    }

    /** Device unplugged — tear down the pipeline (pulsesink is gone). */
    protected async onDeviceDisconnected(): Promise<void> {
        this.settleRestart.cancel();
        this.silent.stop();
        try {
            await super.onStop();
        } catch {
            /* already stopped */
        }
    }

    /** Device returned — rebuild the pipeline. */
    protected async onDeviceReconnected(): Promise<void> {
        await this.readDeviceChannels();
        await super.onStart();
    }

    private async readDeviceChannels(): Promise<void> {
        const info = await this.services?.pipeWire?.getDeviceInfo(this.deviceName);
        this.deviceChannels = info?.channels ?? null;
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
        // With no runner yet this is a start's build, the pipeline that runs; a refresh has one.
        const launch = !this.childProcess;
        if (launch) this.mixerLaunched = false;
        if (!this.services?.mediaRouter) return null;

        const device = (config.device as string) ?? '';
        if (!device) {
            // Broadcast rule: never fall back to a default device.
            this.setHealth('error', 'No audio device configured');
            return null;
        }

        // Seeds held to the ts-offset: one read off a producer's outage burst is stale (B-206).
        const tsOffsetNs = audio302mTsOffsetNs(this.services, config);
        const sources = seedsWithin(this.sources(), tsOffsetNs / 1_000_000);
        if (sources.length === 0) {
            this.setHealth('warning', 'No 302M sources connected');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const channels = (config.channels as number) ?? 2;
        const firstChannel = Math.max(1, Math.trunc(Number(config.firstChannel ?? 1)) || 1);
        const deviceChannels = this.deviceChannels;

        const placement = buildOutputPlacement({ device, channels, firstChannel, deviceChannels });
        if (placement.error !== undefined) {
            this.setHealth('error', placement.error);
            return null;
        }

        // Several sources: the mixer, its inputs apart for the runner to start with the
        // sources that run (B-192). One: the direct branch, its string unchanged.
        const { fragment, continuationName, inputs } =
            sources.length > 1
                ? buildLiveMixInput({ sources, channels, mixerName: MIXER })
                : { ...buildAudioMixInput({ sources, channels }), inputs: undefined };
        if (launch) this.mixerLaunched = sources.length > 1;

        // Present at stamped time + D on the house clock (see the class comment). `name=sink` is
        // what the live offset push and the backlog shedder address; audioconvert/audioresample
        // let pulsesink negotiate whatever format/rate the device wants.
        const sink =
            `pulsesink name=sink device=${device} sync=true provide-clock=false` +
            ` slave-method=${SLAVE_METHOD_SKEW} max-lateness=-1 buffer-time=${SINK_BUFFER_US}` +
            ` ts-offset=${tsOffsetNs} ${pulsePinnedStreamProps()}`;
        // Placement (if any) sits between the VU and the sink: the level meter
        // reads the mix, the sink receives the device-wide spread.
        const pipeline =
            `${fragment} ${continuationName}. ! ${LIVE_UPSTREAM} ! audioconvert ! audioresample` +
            ` ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            (placement.fragment ? ` ! ${placement.fragment}` : '') +
            ` ! ${withLatenessTap('lat_render', sink)}`;

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
            ...(inputs ? { liveInputs: inputs } : {}),
            // What an input delivers from before this launch plays is its outage, skipped as TS at
            // each input's ingress tap: never decoded, never in the mix or its pace (B-206).
            catchUp: { prefix: LAT_IN_PREFIX },
            restartOnError: true,
            // Audio only, nothing to drain; and the mixer arm's aligners hold every EOS
            // (hold-on-eos), so a drain would wait out its 6 s timeout on each stop or rebuild.
            eosDrain: false,
            pipeWireElements: ['sink'],
            timingSink: { element: 'sink', kind: 'audio' },
            // Backlog shedder — the latency ratchet guard on this `sync=true`
            // leg (see backlogShed.ts). Shed point is
            // the pulsesink's OWN pad: raw PCM references nothing, so whole
            // decoded buffers can be dropped anywhere, and its pad is the last
            // place that still sees every one of them. Not keyframe-aligned;
            // the shed is whole-buffer, so the sink sees a timestamp gap and
            // resyncs its ring — one click, at most once a minute, in exchange
            // for the route's configured D. Same shape as the audio-decoder's.
            backlogShed: backlogShedConfig(this.services, {
                element: 'sink',
                sink: 'sink',
                keyframeAligned: false,
                watchPlayout: true,
            }),
        };
    }
}

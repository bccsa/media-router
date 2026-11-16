import {
    CATCH_UP_EVENT,
    DECODE_BYPASS_PPM,
    GstPluginBase,
    LAT_IN_PREFIX,
    buildAsrc,
    buildLatenessTap,
    buildOutputQueue,
    pulsePinnedStreamProps,
    type LiveInputBranch,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    buildAudioMixInput,
    buildLiveMixInput,
    liveInputBranchFor,
    mixInputDemuxes,
    type AudioMixSource,
} from '@media-router/plugin-audio-302m-core';
import { SINK_BUFFER_US, audio302mTsOffsetNs, seedsWithin } from './audio302mTiming.js';
import { launchCatchUpText } from './launchCatchUp.js';
import { buildOutputPlacement } from './outputPlacement.js';
import { SilentOutputWatch } from './silentOutputWatch.js';
import { TimelineSettleRestart } from './timelineSettleRestart.js';

/** Answers LATENCY live (gstidentity.c: `live || sync`), so the sink adds its ring behind the
 *  non-live mixer arm too and one ts-offset holds in both arms; without it that arm plays about
 *  the ring early, or not at all at D = 60. Never waits: buffers come after their running time. */
const LIVE_UPSTREAM = 'identity name=live_upstream sync=true';
/** The output ASRC: the device term, with one source its decode term too (house-clock WI-P3-15). */
const OUT_ASRC = 'outasrc';

const INPUT_PORT_ID = 'audio-in';
/** The render tap: where the mix's content time first plays (B-167's render catch-up). */
const RENDER_TAP = 'lat_render';
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
 * TIMING (B-217, B-249, MR-057). The sink runs `sync=false` and no shedder is armed: late audio plays
 * late, never cut to silence as `sync=true` did on a loaded box. `outasrc` keeps a 60 ms margin in the
 * sink's ring (120 ms at a start) and rebuilds it after a hole, so a feed may get 60 ms later again
 * without one. Its `ts-offset` (D) is still pushed and times nothing; the render tap shows the lateness.
 *
 * CLOCKS (house-clock part 4.4). A source on a clock of its own is resampled to house rate where
 * it is decoded; `outasrc` follows the device's clock, read on a timer (B-166), so the
 * sink never drops or repeats samples for drift. One resampler per path (OQ-23).
 *
 * CHANNEL PLACEMENT. `channels` is the mix width (1–8), `firstChannel` where
 * on the device it lands (X32 outputs 1–32 = four instances at 8 from
 * 1/9/17/25). `buildOutputPlacement` (outputPlacement.ts, ADR-0014) spreads
 * every range but a stereo device's default onto an unpositioned stream by an
 * explicit matrix, upstream of the sink; such a mix has its layout pinned
 * and an unmapped source gets the default map (B-214). The sink element and
 * its timing properties are untouched by placement.
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
 * - Plays nothing (its mixer delivers no audio for 5 s): a warning, not ok; a stalled mixer is
 *   relaunched once (B-197). A late feed is played, not "Plays nothing" (B-217). A launch skips
 *   what its inputs deliver from before it plays (B-206).
 */
export class AudioOutput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    private deviceName = '';
    /** The device's channel count, read before each start: `buildPipeline` cannot wait (B-200). */
    private deviceChannels: number | null = null;
    /** The pipeline launched is the mixer arm (two sources or more), not the direct one. */
    private mixerLaunched = false;
    /** The launched mix's width and layout: a live branch is built to match it (B-214). */
    private launchedMix = { channels: 2, pinnedLayout: false };
    /** The fan-in's demuxes and the connection each decodes, from the last build (WI-P3-6). */
    private demuxes = new Map<string, string>();

    /** A fan-in branch's demux serves its connection's row. */
    protected demuxInputOf(element: string): { connection: string } | undefined {
        const connection = this.demuxes.get(element);
        return connection ? { connection } : undefined;
    }

    /** FF9: relaunch this pipeline once its source settles after a rebase or stall-resume. */
    private readonly settleRestart = new TimelineSettleRestart({
        pipeline: () => this.childProcess,
        log: () => this.log,
    });
    private readonly silent = new SilentOutputWatch({
        pipeline: () => this.childProcess,
        playing: () => this.childProcess?.isRunning === true,
        mixes: () => this.mixerLaunched,
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
        if (channel === CATCH_UP_EVENT) this.logCatchUp(payload);
    }

    /** One INFO line per launch that skipped its inputs' backlog (B-206) or its mix's (B-167). */
    private logCatchUp(payload: unknown): void {
        const router = this.services?.mediaRouter;
        const text = launchCatchUpText(payload, {
            sources: this.sources(),
            name: (id) => router?.moduleName?.(id) ?? id,
            render: { element: RENDER_TAP, label: 'the mix' },
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
        return liveInputBranchFor(MIXER, connectionId, source, this.launchedMix);
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

    /** No Lip-Sync Trim (B-249): on a `sync=false` sink a ts-offset times nothing, and moving a
     *  playing output later or earlier costs a hole or a cut; the trim returns with Phase 4. */
    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
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

        // One source: the direct branch, its decode term left to outasrc, one resampler (OQ-23).
        // Several: the mixer, its inputs apart for the runner to start with those that run (B-192),
        // each branch matching its own source's clock; outasrc is then the device term alone.
        // A placed mix has its layout pinned, every input matrixed onto it (MR-056, B-214).
        const single = sources.length === 1;
        const pinnedLayout = placement.fragment !== null;
        const mixIn = {
            sources,
            channels,
            mixerName: MIXER,
            branchAsrc: false,
            liveInputs: !single,
            pinnedLayout,
        };
        const { fragment, continuationName, inputs } = single
            ? { ...buildAudioMixInput(mixIn), inputs: undefined }
            : buildLiveMixInput(mixIn);
        this.demuxes = mixInputDemuxes(mixIn);
        if (launch) {
            this.mixerLaunched = !single;
            this.launchedMix = { channels, pinnedLayout };
        }
        const outAsrc = buildAsrc({
            name: OUT_ASRC,
            deviceSink: 'sink',
            bypassBelowPpm: single ? DECODE_BYPASS_PPM : 0,
        });

        // `name=sink` is what the live offset push and outasrc address; audioconvert and outasrc
        // (no out-rate: the device's) let pulsesink negotiate the format and rate it wants.
        const sink =
            `pulsesink name=sink device=${device} sync=false provide-clock=false` +
            ` max-lateness=-1 buffer-time=${SINK_BUFFER_US}` +
            ` ts-offset=${tsOffsetNs} ${pulsePinnedStreamProps()}`;
        const chain = [
            `${continuationName}.`,
            LIVE_UPSTREAM,
            // Render lateness is read before outasrc, where PTS is still content time (part 4.4).
            buildLatenessTap(RENDER_TAP),
            'audioconvert',
            outAsrc,
            `volume name=vol volume=${(volumePct / 100).toFixed(2)}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // Placement (if any) sits between the VU and the sink: the level meter
            // reads the mix, the sink receives the device-wide spread.
            placement.fragment,
            // Its own thread before the sink; never leaks: a late or bursty feed waits, it is not dropped.
            buildOutputQueue(),
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
            timing: 'plays as it arrives, late audio late',
            tsOffsetMs: Math.round(tsOffsetNs / 1_000_000),
        });
        this.setHealth('ok');

        return {
            pipeline,
            ...(inputs ? { liveInputs: inputs } : {}),
            // What an input delivers from before this launch plays is its outage, skipped as TS at
            // each input's ingress tap (B-206); once, at the render tap, what the mix queued before
            // it first played, else a sync=false sink keeps that wait as delay for good (B-167).
            catchUp: { prefix: LAT_IN_PREFIX, render: RENDER_TAP },
            restartOnError: true,
            // Audio only, nothing to drain; and the mixer arm's aligners hold every EOS
            // (hold-on-eos), so a drain would wait out its 6 s timeout on each stop or rebuild.
            eosDrain: false,
            pipeWireElements: ['sink'],
            timingSink: { element: 'sink', kind: 'audio' },
            // No backlog shedder (B-166): on this `sync=false` sink its budget, ts-offset plus the
            // sink's latency, reads no latency, so every buffer would read late by its upstream's.
        };
    }
}

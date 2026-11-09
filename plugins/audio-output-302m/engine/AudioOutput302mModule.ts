import {
    CATCH_UP_EVENT,
    DECODE_BYPASS_PPM,
    GstPluginBase,
    LAT_IN_PREFIX,
    OUTPUT_RING_US,
    buildAsrc,
    buildLatenessTap,
    buildOutputPrefill,
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
import { launchCatchUpText } from './launchCatchUp.js';
import { buildOutputPlacement } from './outputPlacement.js';
import { SilentOutputWatch } from './silentOutputWatch.js';

/** The output ASRC: the device term, with one source its decode term too (house-clock WI-P3-15). */
const OUT_ASRC = 'outasrc';
/** Render lateness's tap, where the mix first plays out: the launch's render catch-up (B-167). */
const RENDER_TAP = 'lat_render';

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
 * TIMING (house-clock part 4.1, B-167). It plays as soon as it can: content-time inputs, a 40 ms
 * prefill and a `sync=false` sink on a 100 ms ring (`outputSink.ts`); no playout offset, no trim.
 * A launch skips its inputs' outage and what its mix queued before it first played (B-206, B-167).
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
 * - Plays nothing (its mixer delivers no audio for 5 s): a warning, not ok, and the stalled
 *   mixer is relaunched once (B-197). A device that stops taking samples is `outasrc`'s
 *   `device-stalled` (B-166).
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
        this.silent.stop();
        await this.stopDeviceWatchdog();
        await super.onStop();
    }

    async onDestroy(): Promise<void> {
        this.silent.stop();
        await super.onDestroy();
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === CATCH_UP_EVENT) this.logCatchUp(payload);
    }

    /** One INFO line per launch that skipped its inputs' backlog (B-206) or its mix's (B-167). */
    private logCatchUp(payload: unknown): void {
        const router = this.services?.mediaRouter;
        const text = launchCatchUpText(payload, {
            sources: this.sources(),
            name: (id) => router?.moduleName?.(id) ?? id,
            // One source plays direct: its render tap is that source's (B-172's carry).
            render: { element: RENDER_TAP, label: this.mixerLaunched ? 'the mix' : 'its source' },
        });
        if (text) this.log.info({ catchUp: payload }, text);
    }

    /** A reading is audio the mix delivered (B-197); an empty one is a cleared meter. */
    protected setVuData(data: number[]): void {
        super.setVuData(data);
        if (data.length) this.silent.onVu();
    }

    /** Every PLAYING is a fresh launch: its own time to deliver before it plays nothing. */
    protected onPipelinePlaying(): void {
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

        // A launch's seeds stay 0, as B-206 held them at the default D: a producer's egress
        // lateness read during its own outage burst is stale, and nothing here waits for it.
        const sources = this.sources().map((s) =>
            s.seedLatenessMs === undefined ? s : { ...s, seedLatenessMs: 0 },
        );
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

        // `name=sink` is what outasrc follows; audioconvert and outasrc (no out-rate: the
        // device's) let pulsesink negotiate the format and rate it wants. It writes each sample
        // as it comes (sync=false): no ts-offset, nothing late to drop.
        const sink =
            `pulsesink name=sink device=${device} sync=false provide-clock=false` +
            ` buffer-time=${OUTPUT_RING_US} ${pulsePinnedStreamProps()}`;
        const chain = [
            `${continuationName}.`,
            // Render lateness is read before outasrc, where PTS is still content time (part 4.4).
            buildLatenessTap(RENDER_TAP),
            'audioconvert',
            outAsrc,
            `volume name=vol volume=${(volumePct / 100).toFixed(2)}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // Placement (if any) sits between the VU and the prefill: the level meter
            // reads the mix, the sink receives the device-wide spread.
            placement.fragment,
            buildOutputPrefill(),
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
            timing: 'house clock',
        });
        this.setHealth('ok');

        return {
            pipeline,
            ...(inputs ? { liveInputs: inputs } : {}),
            // What an input delivers from before this launch plays is its outage, skipped as TS at
            // each input's ingress tap: never decoded, never in the mix or its pace (B-206). What
            // the mix queued before it first played (an absent input's wait) at the render tap.
            catchUp: { prefix: LAT_IN_PREFIX, render: RENDER_TAP },
            restartOnError: true,
            // Audio only, nothing to drain; and the mixer arm's aligners hold every EOS
            // (hold-on-eos), so a drain would wait out its 6 s timeout on each stop or rebuild.
            eosDrain: false,
            pipeWireElements: ['sink'],
            timingSink: { element: 'sink', kind: 'audio' },
        };
    }
}

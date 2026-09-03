import {
    GstPluginBase,
    backlogShedConfig,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import { buildAudioMixInput } from '@media-router/plugin-audio-302m-core';
import { SINK_BUFFER_US, SLAVE_METHOD_SKEW, audio302mTsOffsetNs } from './audio302mTiming.js';

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
 * presents at `stamped-time + D` on the house clock — `sync=true`, `ts-offset`
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
 * With the contract off the pipeline string is byte-for-byte what it was
 * (`pulsesink device=… sync=false`): the kill-switch has to reproduce the
 * legacy behaviour exactly.
 *
 * - Volume/mute: gst `volume` element (single attenuation point).
 * - VU: in-pipeline `level` element (post-volume = what is being played).
 * - Device hot-plug: base-class device watchdog stops/starts the pipeline.
 * - NEVER a default device (broadcast rule): unconfigured device = health
 *   error, no pipeline.
 */
export class AudioOutput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled', 'lipSyncMs'];

    private deviceName = '';
    /**
     * Aggregation latency the RUNNING pipeline's mixer arm declared (ns), 0 in
     * the single-source arm — see `audio302mTsOffsetNs`. Kept so a live
     * `ts-offset` push applies the same subtraction the build did; the value
     * only changes with a rebuild (source count is not live).
     */
    private mixerLatencyNs = 0;

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

    /**
     * Push the resolved ts-offset to the running `pulsesink`. No-op on the
     * legacy path: without the contract the sink carries no `name=sink` (the
     * pipeline string is unchanged there), so there is nothing to address.
     */
    private async pushSinkTsOffset(): Promise<void> {
        if (this.services?.timeSyncContract !== true) return;
        await this.setElementProperty(
            'sink',
            'ts-offset',
            audio302mTsOffsetNs(this.services, this.config, this.mixerLatencyNs),
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

        const { fragment, continuationName, mixerLatencyNs, demuxes } = buildAudioMixInput({
            sources,
            channels,
            latencyMs: Number(config.mixLatencyMs ?? 200),
        });
        this.mixerLatencyNs = mixerLatencyNs ?? 0;

        const contract = this.services?.timeSyncContract === true;
        const tsOffsetNs = contract
            ? audio302mTsOffsetNs(this.services, config, this.mixerLatencyNs)
            : 0;

        // CONTRACT: present at stamped time + D on the house clock — see the
        // class comment. `name=sink` is what the live offset push and the
        // backlog shedder address; it is added only here so the legacy string
        // below stays byte-identical.
        //
        // LEGACY (contract off): sync=false — the force-live mixer already paces
        // output in real time, and a syncing sink would only add the
        // decoder-era mid-stream-join silence trap on top. audioconvert/
        // audioresample let pulsesink negotiate whatever format/rate the device
        // wants.
        const sink = contract
            ? `pulsesink name=sink device=${device} sync=true provide-clock=false` +
              ` slave-method=${SLAVE_METHOD_SKEW} max-lateness=-1 buffer-time=${SINK_BUFFER_US}` +
              ` ts-offset=${tsOffsetNs}`
            : `pulsesink device=${device} sync=false`;
        const pipeline =
            `${fragment} ${continuationName}. ! audioconvert ! audioresample` +
            ` ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ` ! ${sink}`;

        this.setStatusData('output', {
            device,
            sources: sources.length,
            timing: contract ? 'house clock, playout offset' : 'on arrival',
            ...(contract ? { tsOffsetMs: Math.round(tsOffsetNs / 1_000_000) } : {}),
        });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
            // Backlog shedder — the contract's latency ratchet guard, on the leg
            // the contract turned `sync=true` (see backlogShed.ts). Shed point is
            // the pulsesink's OWN pad: raw PCM references nothing, so whole
            // decoded buffers can be dropped anywhere, and its pad is the last
            // place that still sees every one of them. Not keyframe-aligned;
            // the shed is whole-buffer, so the sink sees a timestamp gap and
            // resyncs its ring — one click, at most once a minute, in exchange
            // for the route's configured D. Same shape as the audio-decoder's.
            ...(contract
                ? {
                      backlogShed: backlogShedConfig(this.services, {
                          element: 'sink',
                          sink: 'sink',
                          keyframeAligned: false,
                      }),
                      // Anchor every branch's running time to the producer's
                      // house stamps (ADR-0005 Stage 3c — the same correction the
                      // mpegts-muxer applies to its inputs). A tsdemux keeps the
                      // zero-point error of the one bus buffer it locked on for
                      // its whole life (−73…−85 ms measured on .103, re-rolled per
                      // restart); on a sync=true leg that error IS lipsync.
                      alignBranchesToStamps: { demuxes },
                  }
                : {}),
        };
    }
}

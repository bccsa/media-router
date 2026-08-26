import { GstPluginBase, type ModuleServices, type PipelineDescription } from '@media-router/engine';
import { buildAudioMixInput } from '@media-router/plugin-audio-302m-core';

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
 * - Volume/mute: gst `volume` element (single attenuation point).
 * - VU: in-pipeline `level` element (post-volume = what is being played).
 * - Device hot-plug: base-class device watchdog stops/starts the pipeline.
 * - NEVER a default device (broadcast rule): unconfigured device = health
 *   error, no pipeline.
 */
export class AudioOutput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    private deviceName = '';

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

        const { fragment, continuationName } = buildAudioMixInput({
            sources,
            channels,
            latencyMs: Number(config.mixLatencyMs ?? 200),
        });

        // sync=false: the force-live mixer already paces output in real time;
        // a syncing sink would only add the decoder-era mid-stream-join
        // silence trap on top. audioconvert/audioresample let pulsesink
        // negotiate whatever format/rate the device wants.
        const pipeline =
            `${fragment} ${continuationName}. ! audioconvert ! audioresample` +
            ` ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ` ! pulsesink device=${device} sync=false`;

        this.setStatusData('output', {
            device,
            sources: sources.length,
        });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
        };
    }
}

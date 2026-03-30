import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Audio Output plugin.
 *
 * Creates a native module-remap-sink that maps to the real hardware device.
 * Routing connections target the remap-sink (no GStreamer in the audio path).
 *
 * A separate lightweight GStreamer process reads from the remap-sink's monitor
 * for VU metering only.
 *
 * Volume is controlled via PipeWire sink volume (pactl set-sink-volume).
 */
export class AudioOutputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    private deviceName = '';
    private detectedChannels: number | null = null;
    private detectedSampleRate: number | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';

        // Detect device channels and sample rate from PipeWire
        if (this.services?.pipeWire && this.deviceName) {
            const info = this.services.pipeWire.getDeviceInfo(this.deviceName);
            if (info) {
                this.detectedChannels = info.channels;
                this.detectedSampleRate = info.sampleRate;
            }
        }
    }

    async onStart(): Promise<void> {
        if (!this.deviceName) {
            throw new Error('No audio device configured');
        }

        const channels = this.detectedChannels ?? (this.config.channels as number) ?? 2;
        const rate = this.detectedSampleRate ?? (this.config.sampleRate as number) ?? 48000;

        if (this.services?.pipeWire) {
            // Create a native remap-sink instead of null-sink.
            // Audio stays entirely in PipeWire — no GStreamer buffering in the signal path.
            this.paModuleId = await this.services.pipeWire.loadRemapSink(
                this.services.instanceId, this.deviceName, channels, rate, this.services.instanceId,
            );

            // Set initial volume on the remap sink
            const vol = (this.config.volume as number) ?? 100;
            await this.services.pipeWire.setSinkVolume(this.pwNodeName, vol);
        }

        // Start VU metering pipeline (reads from remap-sink monitor directly — no loopback needed)
        await super.onStart();
    }

    async onStop(): Promise<void> {
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            // Volume controlled natively via PipeWire — no GStreamer element needed
            if (this.services?.pipeWire) {
                await this.services.pipeWire.setSinkVolume(this.pwNodeName, volumePct);
            }
        }
    }

    /** Routing connections target the remap-sink. */
    getPipeWireNodes(): { source?: string; sink?: string } {
        return { sink: this.pwNodeName };
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription {
        // VU metering only — reads from remap-sink monitor, measures level, discards audio.
        // No volume element needed (volume is controlled natively via PipeWire).
        const pipeline = [
            `pulsesrc device=${this.pwNodeName}.monitor buffer-time=20000 latency-time=10000`,
            'audioconvert',
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            'fakesink sync=false',
        ].join(' ! ');

        return { pipeline };
    }
}

import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Audio Input plugin.
 *
 * Captures audio from a PipeWire/PulseAudio source device using a native
 * module-remap-source (no GStreamer in the audio path). Matches v1 architecture:
 * - module-remap-source with remix=no and latency_msec=50
 * - Separate lightweight GStreamer process for VU metering only
 * - Volume via pactl set-source-volume on the remap source
 */
export class AudioInputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    private deviceName = '';
    private detectedChannels: number | null = null;
    private detectedSampleRate: number | null = null;
    private remapModuleId: number | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';

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
            // Create remap-source — matches v1 exactly: remix=no, latency_msec=50
            this.remapModuleId = await this.services.pipeWire.loadRemapSource(
                this.services.instanceId, this.deviceName, channels, rate, this.services.instanceId,
            );

            const ready = await this.services.pipeWire.waitForSource(this.pwNodeName);
            if (!ready) {
                this.log.warn({ pwNodeName: this.pwNodeName }, 'Remap source not confirmed — proceeding anyway');
            }

            const vol = (this.config.volume as number) ?? 100;
            await this.services.pipeWire.setSourceVolume(this.pwNodeName, vol);
        }

        // VU pipeline reads directly from the remap source (same as v1).
        // PipeWire multiplexes — pulsesrc doesn't consume the source exclusively.
        await super.onStart();
    }

    async onStop(): Promise<void> {
        this.remapModuleId = null;
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            if (this.services?.pipeWire) {
                await this.services.pipeWire.setSourceVolume(this.pwNodeName, volumePct);
            }
        }
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        return { source: this.pwNodeName };
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription {
        // VU metering only — reads directly from the remap source.
        const pipeline = [
            `pulsesrc device=${this.pwNodeName} buffer-time=20000 latency-time=10000`,
            'audioconvert',
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            'fakesink sync=false',
        ].join(' ! ');

        return { pipeline };
    }
}

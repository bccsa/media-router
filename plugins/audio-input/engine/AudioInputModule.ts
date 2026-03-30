import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Audio Input plugin.
 *
 * Captures audio from a PipeWire/PulseAudio source device using a native
 * module-remap-source (no GStreamer in the audio path). A separate lightweight
 * GStreamer process reads from the remap source's monitor for VU metering only.
 *
 * Volume is controlled via PipeWire source volume (pactl set-source-volume).
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

        // Create a native remap-source instead of null-sink + GStreamer pipeline.
        // Audio stays entirely in PipeWire — no GStreamer buffering in the signal path.
        if (this.services?.pipeWire) {
            this.remapModuleId = await this.services.pipeWire.loadRemapSource(
                this.services.instanceId, this.deviceName, channels, rate, this.services.instanceId,
            );

            // Wait for the remap source to appear before starting VU pipeline
            const ready = await this.services.pipeWire.waitForSource(this.pwNodeName);
            if (!ready) {
                this.log.warn({ pwNodeName: this.pwNodeName }, 'Remap source not confirmed — proceeding anyway');
            }

            // Set initial volume on the remap source
            const vol = (this.config.volume as number) ?? 100;
            await this.services.pipeWire.setSourceVolume(this.pwNodeName, vol);

            // Create a null-sink to tap the remap source for VU metering.
            // pulsesrc reads from the null-sink's monitor (passive tap), avoiding
            // interference with downstream loopback connections on the remap source.
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                `${this.services.instanceId}_vu`, channels, rate, this.services.instanceId,
            );
            await this.services.pipeWire.waitForSink(`${this.pwNodeName}_vu`);

            // Loopback from remap source into the VU null-sink
            await this.services.pipeWire.loadLoopback(
                `vu-${this.services.instanceId}`,
                this.pwNodeName,
                `${this.pwNodeName}_vu`,
                channels, rate,
                this.services.instanceId,
            );
        }

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
        // Remap-source IS a source — no .monitor needed
        return { source: this.pwNodeName };
    }

    buildPipeline(_config: Record<string, unknown>): PipelineDescription {
        // VU metering only — reads from the VU null-sink monitor (passive tap of remap source).
        const pipeline = [
            `pulsesrc device=${this.pwNodeName}_vu.monitor buffer-time=20000 latency-time=10000`,
            'audioconvert',
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            'fakesink sync=false',
        ].join(' ! ');

        return { pipeline };
    }
}

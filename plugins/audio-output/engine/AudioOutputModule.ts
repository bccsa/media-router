import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Audio Output plugin.
 *
 * Routing connections target the REAL output device directly (not a null-sink).
 * This avoids the issue of pulsesrc not detecting new loopback audio.
 *
 * A separate null-sink + GStreamer pipeline is used only for VU metering:
 * a loopback from the real device's monitor feeds VU data.
 *
 * Volume is controlled via PipeWire sink volume (pactl).
 */
export class AudioOutputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    private deviceName = '';
    private detectedChannels: number | null = null;
    private detectedSampleRate: number | null = null;
    /** PA module ID for the VU metering loopback (device.monitor → null-sink). */
    private vuLoopbackId: number | null = null;

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
        const channels = this.detectedChannels ?? (this.config.channels as number) ?? 2;
        const rate = this.detectedSampleRate ?? (this.config.sampleRate as number) ?? 48000;

        if (this.services?.pipeWire) {
            // Create null-sink for VU metering only
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId, channels, rate, this.services.instanceId,
            );

            // Set initial volume on the real output device
            const vol = (this.config.volume as number) ?? 100;
            if (this.deviceName) {
                await this.services.pipeWire.setSinkVolume(this.deviceName, vol);
            }
        }

        // Start the VU metering pipeline (reads from null-sink monitor)
        await super.onStart();

        // Create a loopback from the real device's monitor to our null-sink for VU metering
        if (this.services?.pipeWire && this.deviceName) {
            try {
                this.vuLoopbackId = await this.services.pipeWire.loadLoopback(
                    `vu-${this.services.instanceId}`,
                    `${this.deviceName}.monitor`,
                    this.pwNodeName,
                    channels, rate,
                    this.services.instanceId,
                );
            } catch { /* VU loopback is optional */ }
        }
    }

    async onStop(): Promise<void> {
        await super.onStop();
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            const gstVol = volumePct / 100;
            await this.setElementProperty('vol', 'volume', gstVol).catch(() => {});
            if (this.services?.pipeWire && this.deviceName) {
                await this.services.pipeWire.setSinkVolume(this.deviceName, volumePct);
            }
        }
    }

    /** Audio output routes directly to the real device — no null-sink in the audio path. */
    getPipeWireNodes(): { source?: string; sink?: string } {
        return { sink: this.deviceName };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        const sampleRate = this.detectedSampleRate ?? (config.sampleRate as number) ?? 48000;
        const channels = this.detectedChannels ?? (config.channels as number) ?? 2;

        // VU-only pipeline: reads from null-sink monitor, applies volume, then measures level
        const volumePct = (config.volume as number) ?? 100;
        const gstVolume = (volumePct / 100).toFixed(2);
        const source = `pulsesrc device=${this.pwNodeName}.monitor buffer-time=20000 latency-time=10000`;
        const format = `audioconvert`;
        const vol = `volume name=vol volume=${gstVolume}`;
        const level = 'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000';
        const pipeline = `${source} ! ${format} ! ${vol} ! ${level} ! fakesink sync=false`;

        return {
            pipeline,
            liveElements: { vol: ['volume'] },
        };
    }
}

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

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';

        // Detect device channels and sample rate from PipeWire
        if (this.services?.pipeWire && this.deviceName) {
            const info = this.services.pipeWire.getDeviceInfo(this.deviceName);
            if (info) {
                this.detectedChannels = info.channels;
                this.detectedSampleRate = info.sampleRate;

                // Write detected values back to config so the UI and channel-map editor
                // see the real port count, not the stale stored default.
                const changes: Record<string, unknown> = {};
                if (info.channels > 0 && info.channels !== config.channels) {
                    changes.channels = info.channels;
                }
                if (info.sampleRate > 0 && info.sampleRate !== config.sampleRate) {
                    changes.sampleRate = info.sampleRate;
                }
                if (Object.keys(changes).length > 0) this.emitConfigUpdate(changes);
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
                this.services.instanceId,
                this.deviceName,
                channels,
                rate,
                this.services.instanceId,
            );

            // Respect audioEnabled on start — otherwise a muted module unmutes
            // itself when restarted (PipeWire volume resets to config.volume).
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const vol = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.services.pipeWire.setSinkVolume(this.pwNodeName, vol);
        }

        // Start VU metering pipeline (reads from remap-sink monitor directly — no loopback needed)
        await super.onStart();
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        this.stopDeviceWatchdog();
        this.paModuleId = null;
        await super.onStop();
    }

    /** Base-class hook: device unplugged — tear down the GStreamer pipeline. */
    protected async onDeviceDisconnected(): Promise<void> {
        try {
            await super.onStop();
        } catch {
            /* already stopped */
        }
    }

    /** Base-class hook: device returned — rebuild the remap-sink then restart the pipeline. */
    protected async onDeviceReconnected(): Promise<void> {
        if (this.services?.pipeWire) {
            const channels = this.detectedChannels ?? (this.config.channels as number) ?? 2;
            const rate = this.detectedSampleRate ?? (this.config.sampleRate as number) ?? 48000;
            this.paModuleId = await this.services.pipeWire.loadRemapSink(
                this.services.instanceId,
                this.deviceName,
                channels,
                rate,
                this.services.instanceId,
            );
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const vol = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.services.pipeWire.setSinkVolume(this.pwNodeName, vol);
        }
        await super.onStart();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            if (this.services?.pipeWire) {
                await this.services.pipeWire.setSinkVolume(this.pwNodeName, volumePct);
            }
        }
    }

    /** Routing connections target the remap-sink. */
    getPipeWireNodes(): { source?: string; sink?: string } {
        return { sink: this.pwNodeName };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        // VU metering only — reads from the real device's monitor (post-volume).
        // The remap-sink monitor shows pre-volume audio, so we tap the master device instead.
        // Caps-limit channels so audioconvert doesn't upmix mono to stereo —
        // level reports one peak per channel, and we want reality.
        const channels = (config.channels as number) ?? this.detectedChannels ?? 2;
        const pipeline = [
            `pulsesrc device=${this.deviceName}.monitor buffer-time=20000 latency-time=10000`,
            'audioconvert',
            `audio/x-raw,channels=${channels}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            'fakesink sync=false',
        ].join(' ! ');

        return { pipeline };
    }
}

import {
    GstPluginBase,
    type PipelineDescription,
    type EngineServices,
    type ModuleServices,
    type Device,
} from '@media-router/engine';

/**
 * Audio Input plugin.
 *
 * Captures audio from a PipeWire/PulseAudio source device using a native
 * module-remap-source (no GStreamer in the audio path). Matches v1 architecture:
 * - module-remap-source with remix=no and latency_msec=50
 * - Separate lightweight GStreamer process for VU metering only
 * - Volume via pactl set-source-volume on the remap source
 *
 * Also owns the `audio-source` device type — registers a device provider
 * during plugin load so the manager-UI's dropdown populates from PipeWire's
 * source list. The `audio-sink` type is owned symmetrically by audio-output.
 */
export class AudioInputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    private deviceName = '';
    private detectedChannels: number | null = null;
    private detectedSampleRate: number | null = null;
    private remapModuleId: number | null = null;

    static registerServices(services: EngineServices): void {
        services.deviceProviders.register({
            type: 'audio-source',
            list: () =>
                services.pipeWire
                    .listDevices()
                    .filter((d) => d.direction === 'source')
                    .map(
                        (d): Device => ({
                            name: d.name,
                            label: `${d.description || d.name} (${d.channels ?? '?'}ch, ${d.sampleRate ?? '?'}Hz)`,
                            meta: {
                                direction: d.direction,
                                channels: d.channels,
                                sampleRate: d.sampleRate,
                            },
                        }),
                    ),
        });
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';

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
            // Create remap-source — matches v1 exactly: remix=no, latency_msec=50
            this.remapModuleId = await this.services.pipeWire.loadRemapSource(
                this.services.instanceId,
                this.deviceName,
                channels,
                rate,
                this.services.instanceId,
            );

            const ready = await this.services.pipeWire.waitForSource(this.pwNodeName);
            if (!ready) {
                this.log.warn(
                    { pwNodeName: this.pwNodeName },
                    'Remap source not confirmed — proceeding anyway',
                );
            }

            // Respect audioEnabled on start — otherwise a muted module unmutes
            // itself when restarted (PipeWire volume resets to config.volume).
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const vol = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.services.pipeWire.setSourceVolume(this.pwNodeName, vol);
        }

        // VU pipeline reads directly from the remap source (same as v1).
        // PipeWire multiplexes — pulsesrc doesn't consume the source exclusively.
        await super.onStart();
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        this.stopDeviceWatchdog();
        this.remapModuleId = null;
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

    /** Base-class hook: device returned — rebuild the remap-source then restart the pipeline. */
    protected async onDeviceReconnected(): Promise<void> {
        if (this.services?.pipeWire) {
            const channels = this.detectedChannels ?? (this.config.channels as number) ?? 2;
            const rate = this.detectedSampleRate ?? (this.config.sampleRate as number) ?? 48000;
            this.remapModuleId = await this.services.pipeWire.loadRemapSource(
                this.services.instanceId,
                this.deviceName,
                channels,
                rate,
                this.services.instanceId,
            );
            await this.services.pipeWire.waitForSource(this.pwNodeName);
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const vol = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.services.pipeWire.setSourceVolume(this.pwNodeName, vol);
        }
        await super.onStart();
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

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        // VU metering only — reads directly from the remap source.
        // Caps-limit channels so audioconvert doesn't upmix mono to stereo —
        // the level element reports one peak per channel, and we want reality.
        const channels = (config.channels as number) ?? this.detectedChannels ?? 2;
        const pipeline = [
            `pulsesrc device=${this.pwNodeName} buffer-time=20000 latency-time=10000`,
            'audioconvert',
            `audio/x-raw,channels=${channels}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            'fakesink sync=false',
        ].join(' ! ');

        return { pipeline };
    }
}

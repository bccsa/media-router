import {
    GstPluginBase,
    detectDeviceFormat,
    resolveDeviceFormat,
    tryResolveDeviceFormat,
    registerPipeWireDeviceProvider,
    type PipelineDescription,
    type EngineServices,
    type ModuleServices,
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
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';

        const det = detectDeviceFormat(this.services?.pipeWire, this.deviceName, {
            channels: config.channels as number | undefined,
            sampleRate: config.sampleRate as number | undefined,
        });
        this.detectedChannels = det.detected.channels;
        this.detectedSampleRate = det.detected.sampleRate;
        if (Object.keys(det.configUpdates).length > 0) this.emitConfigUpdate(det.configUpdates);
        if (det.healthWarning) this.setHealth('warning', det.healthWarning);
    }

    async onStart(): Promise<void> {
        if (!this.deviceName) {
            throw new Error('No audio device configured');
        }

        // If the device isn't enumerated yet, defer setup to the watchdog.
        // Throwing here would prevent the watchdog from starting at all,
        // leaving hot-plug undetected — the module would only recover on
        // an engine restart.
        if (this.services?.pipeWire && !this.services.pipeWire.hasDevice(this.deviceName)) {
            this.setHealth(
                'warning',
                `Audio device "${this.deviceName}" not connected — waiting for hot-plug`,
            );
            this.startDeviceWatchdog(false);
            return;
        }

        const { channels, rate, detected } = resolveDeviceFormat(
            this.services?.pipeWire,
            this.deviceName,
            { channels: this.detectedChannels, sampleRate: this.detectedSampleRate },
            {
                channels: this.config.channels as number | undefined,
                sampleRate: this.config.sampleRate as number | undefined,
            },
            'input',
        );
        this.detectedChannels = detected.channels;
        this.detectedSampleRate = detected.sampleRate;

        await this.bringUpRemapSourceAndPipeline(channels, rate);
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
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
        // The disconnect path bypasses `ModuleInstance.stop`'s `releaseAll`,
        // so unload here. Otherwise the next `loadRemapSource` (on reconnect)
        // would collide on `source_name=MR_PW_<id>`.
        if (this.remapModuleId !== null && this.services?.pipeWire) {
            try {
                await this.services.pipeWire.unloadModule(this.remapModuleId);
            } catch {
                /* ignore — best-effort cleanup */
            }
            this.remapModuleId = null;
        }
    }

    /** Base-class hook: device returned — rebuild the remap-source then restart the pipeline. */
    protected async onDeviceReconnected(): Promise<void> {
        const resolved = tryResolveDeviceFormat(
            this.services?.pipeWire,
            this.deviceName,
            { channels: this.detectedChannels, sampleRate: this.detectedSampleRate },
            {
                channels: this.config.channels as number | undefined,
                sampleRate: this.config.sampleRate as number | undefined,
            },
        );
        this.detectedChannels = resolved.detected.channels;
        this.detectedSampleRate = resolved.detected.sampleRate;
        if (!resolved.channels || !resolved.rate) {
            // Throw so the watchdog leaves `deviceConnected=false` and
            // retries on the next tick — silently returning would have
            // the watchdog flip health to 'ok' with no remap-source.
            throw new Error(
                `Reconnected device "${this.deviceName}" has unknown channel count or sample rate`,
            );
        }
        await this.bringUpRemapSourceAndPipeline(resolved.channels, resolved.rate);
    }

    /**
     * Shared body for both the cold-start success path and watchdog-driven
     * reconnect: load the native remap-source (matches v1: remix=no,
     * latency_msec=50), wait for it to appear, set volume, then start the
     * VU pipeline. PipeWire multiplexes the remap source — pulsesrc doesn't
     * consume it exclusively, so the VU pipeline can read it directly.
     */
    private async bringUpRemapSourceAndPipeline(channels: number, rate: number): Promise<void> {
        if (this.services?.pipeWire) {
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
        // `onStart` and `onDeviceReconnected` both throw if neither the live
        // probe nor the persisted config gives us a channel count, so one of
        // these two sources is guaranteed to be set by the time we get here.
        const channels = (config.channels as number | undefined) ?? this.detectedChannels!;
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

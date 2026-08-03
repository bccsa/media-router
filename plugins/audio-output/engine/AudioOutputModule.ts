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
 * Audio Output plugin.
 *
 * Creates a native module-remap-sink that maps to the real hardware device.
 * Routing connections target the remap-sink (no GStreamer in the audio path).
 *
 * A separate lightweight GStreamer process reads from the remap-sink's monitor
 * for VU metering only.
 *
 * Volume is controlled via PipeWire sink volume (pactl set-sink-volume).
 *
 * Also owns the `audio-sink` device type — registers a device provider during
 * plugin load so the manager-UI's dropdown populates from PipeWire's sink
 * list. The `audio-source` type is owned symmetrically by audio-input.
 */
export class AudioOutputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    private deviceName = '';
    private detectedChannels: number | null = null;
    private detectedSampleRate: number | null = null;

    static registerServices(services: EngineServices): void {
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
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
            'output',
        );
        this.detectedChannels = detected.channels;
        this.detectedSampleRate = detected.sampleRate;

        await this.bringUpRemapSinkAndPipeline(channels, rate);
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
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
        // The disconnect path bypasses `ModuleInstance.stop`'s `releaseAll`,
        // so unload here. Otherwise the next `loadRemapSink` (on reconnect)
        // would collide on `sink_name=MR_PW_<id>`.
        if (this.paModuleId !== null && this.services?.pipeWire) {
            try {
                await this.services.pipeWire.unloadModule(this.paModuleId);
            } catch {
                /* ignore — best-effort cleanup */
            }
            this.paModuleId = null;
        }
    }

    /** Base-class hook: device returned — rebuild the remap-sink then restart the pipeline. */
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
            // the watchdog flip health to 'ok' with no remap-sink.
            throw new Error(
                `Reconnected device "${this.deviceName}" has unknown channel count or sample rate`,
            );
        }
        await this.bringUpRemapSinkAndPipeline(resolved.channels, resolved.rate);
        // The remap-sink is a NEW PipeWire node — every routed pw-link into
        // the old one died with it. Re-execute them or the module sits IDLE
        // with zero inbound links, silent while reporting running (field
        // 2026-08-02: HDMI monitor power-cycle).
        if (this.services?.mediaRouter?.reexecuteIncomingPwLinks) {
            await this.services.mediaRouter.reexecuteIncomingPwLinks(this.services.instanceId);
        }
    }

    /**
     * Shared body for both the cold-start success path and watchdog-driven
     * reconnect: load the native remap-sink (audio stays in PipeWire — no
     * GStreamer in the signal path) and start the VU pipeline. The VU
     * pipeline reads the master device's monitor (post-volume), so the
     * remap-sink existing is enough; `super.onStart` waits for it to appear.
     */
    private async bringUpRemapSinkAndPipeline(channels: number, rate: number): Promise<void> {
        if (this.services?.pipeWire) {
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
        // `onStart` and `onDeviceReconnected` both throw if neither the live
        // probe nor the persisted config gives us a channel count, so one of
        // these two sources is guaranteed to be set by the time we get here.
        const channels = (config.channels as number | undefined) ?? this.detectedChannels!;
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

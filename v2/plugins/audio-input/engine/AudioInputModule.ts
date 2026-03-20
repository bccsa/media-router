import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/**
 * Audio Input plugin.
 *
 * Captures audio from a PipeWire/PulseAudio source device. Creates a named
 * null-sink so other modules can read from its `.monitor` source via loopback.
 * Volume is controlled via PipeWire source volume (pactl).
 */
export class AudioInputModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume'];
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
        // Use detected values, fall back to config
        const channels = this.detectedChannels ?? (this.config.channels as number) ?? 2;
        const rate = this.detectedSampleRate ?? (this.config.sampleRate as number) ?? 48000;

        // Create a named null-sink before starting the pipeline
        if (this.services?.pipeWire) {
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId, channels, rate, this.services.instanceId,
            );

            // Set initial volume on the real device
            const vol = (this.config.volume as number) ?? 100;
            if (this.deviceName) {
                await this.services.pipeWire.setSourceVolume(this.deviceName, vol);
            }
        }

        await super.onStart();
    }

    async onStop(): Promise<void> {
        await super.onStop();
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        if ('volume' in changes && this.services?.pipeWire) {
            await this.services.pipeWire.setSourceVolume(this.deviceName, changes.volume as number);
        }
        Object.assign(this.config, changes);
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Other modules read from our null-sink's monitor
        return { source: `${this.pwNodeName}.monitor` };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        const device = (config.device as string) ?? '';
        // Use detected values from PipeWire, fall back to config
        const sampleRate = this.detectedSampleRate ?? (config.sampleRate as number) ?? 48000;
        const channels = this.detectedChannels ?? (config.channels as number) ?? 2;

        const deviceProp = device ? `device="${device}"` : '';
        const source = `pulsesrc ${deviceProp} buffer-time=20000 latency-time=10000`.trim();
        const format = `audioconvert ! audioresample ! audio/x-raw,rate=${sampleRate},channels=${channels}`;
        const level = 'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000';

        // Output to our named null-sink (other modules connect via loopback to its .monitor)
        const sink = `pulsesink device=${this.pwNodeName} buffer-time=20000 latency-time=10000 sync=false`;

        const pipeline = `${source} ! ${format} ! ${level} ! ${sink}`;

        return { pipeline };
    }
}

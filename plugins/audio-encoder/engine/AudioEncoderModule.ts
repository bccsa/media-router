import { execFile } from 'child_process';
import { GstPluginBase, type PipelineDescription, type ModuleServices } from '@media-router/engine';

/** Parse max channels from gst-inspect output for an element. */
function gstInspectMaxChannels(element: string): Promise<number> {
    return new Promise((resolve) => {
        execFile('gst-inspect-1.0', [element], { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(2);
            // Find "channels: [ 1, N ]" — take the smallest max across all pad templates
            let min = Infinity;
            for (const m of stdout.matchAll(/channels:\s*\[\s*\d+\s*,\s*(\d+)\s*\]/g)) {
                min = Math.min(min, parseInt(m[1], 10));
            }
            resolve(min === Infinity ? 2 : min);
        });
    });
}

/**
 * Audio Encoder plugin.
 *
 * Creates a named null-sink that other modules feed into via loopback.
 * Reads from the null-sink's monitor, encodes to Opus/AAC, muxes into MPEG-TS,
 * and writes to stdout (fd 1) for piping to other modules (RIST, SRT, etc.).
 */
export class AudioEncoderModule extends GstPluginBase {
    /** Called by PluginLoader after loading — detect GStreamer capabilities and update schema. */
    static async initManifest(manifest: Record<string, any>): Promise<void> {
        const [opusMax, aacMax] = await Promise.all([
            gstInspectMaxChannels('opusenc'),
            gstInspectMaxChannels('avenc_aac'),
        ]);
        const props = (manifest.configSchema as any)?.properties;
        if (props?.channels) {
            props.channels.maximum = Math.max(opusMax, aacMax);
            props.channels['x-maxBy'] = { field: 'codec', map: { opus: opusMax, aac: aacMax } };
        }
    }

    protected liveUpdatableParams = ['bitrate', 'volume', 'audioEnabled'];

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        // Normalize config — write resolved defaults back so downstream modules can read them
        const codec = (this.config.codec as string) ?? 'opus';
        const channels = (this.config.channels as number) ?? 2;
        const rate = (this.config.sampleRate as number) ?? 48000;
        this.config.codec = codec;
        this.config.channels = channels;
        this.config.sampleRate = rate;

        // Create a named null-sink — audio sources loopback into this
        if (this.services?.pipeWire) {
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId, channels, rate, this.services.instanceId,
            );
        }

        await super.onStart();
        this.updateStatusData();

        // Poll udpsink bytes-served every 2s for live throughput stats
        this.lastBytes = 0;
        this.lastPollTime = Date.now();
        this.statsTimer = setInterval(async () => {
            try {
                const bytesServed = await this.getElementProperty('usink', 'bytes-served') as number;
                if (typeof bytesServed === 'number') {
                    const now = Date.now();
                    const elapsed = (now - this.lastPollTime) / 1000;
                    const deltaBytes = bytesServed - this.lastBytes;
                    const bitrateKbps = elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0;
                    this.lastBytes = bytesServed;
                    this.lastPollTime = now;
                    this.setStatusData('throughput', {
                        'Output Bitrate': `${bitrateKbps} kbps`,
                        'Total Bytes': `${(bytesServed / 1024 / 1024).toFixed(1)} MB`,
                    });
                }
            } catch { /* ignore */ }
        }, 2000);
    }

    private statsTimer: ReturnType<typeof setInterval> | null = null;
    private lastBytes = 0;
    private lastPollTime = 0;

    private updateStatusData(): void {
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getEncoderEndpoint(instanceId);
        this.setStatusData('encoder', {
            codec: (this.config.codec as string) ?? 'opus',
            bitrate: (this.config.bitrate as number) ?? 128,
            frameSize: (this.config.frameSize as number) ?? 20,
            sampleRate: (this.config.sampleRate as number) ?? 48000,
            channels: (this.config.channels as number) ?? 2,
        });
        this.setStatusData('udp', {
            host: endpoint?.host ?? '—',
            port: endpoint?.port ?? 0,
        });
    }

    async onStop(): Promise<void> {
        if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
        await super.onStop();
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            // Volume controlled via GStreamer element only — no pactl to avoid double-attenuation
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => { this.log.debug({ err }, 'Volume update failed (pipeline may not be running)'); });
        }
        if ('bitrate' in changes) {
            const codec = (this.config.codec as string) ?? 'opus';
            const elementName = codec === 'aac' ? 'avenc_aac0' : 'opusenc0';
            await this.setElementProperty(elementName, 'bitrate', (changes.bitrate as number) * 1000);
        }
        this.updateStatusData();
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Audio sources loopback into our null-sink
        return { sink: this.pwNodeName };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        const codec = (config.codec as string) ?? 'opus';
        const bitrate = (config.bitrate as number) ?? 128;
        const sampleRate = (config.sampleRate as number) ?? 48000;
        const channels = (config.channels as number) ?? 2;
        const volumePct = (config.volume as number) ?? 100;
        const gstVolume = (volumePct / 100).toFixed(2);

        // Read from our null-sink's monitor
        const source = `pulsesrc device=${this.pwNodeName}.monitor`;
        const format = `audioconvert ! audioresample ! audio/x-raw,rate=${sampleRate},channels=${channels}`;
        const vol = `volume name=vol volume=${gstVolume}`;
        const level = 'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000';

        // Encoder always gets a UDP multicast port assigned at startup.
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.assignEncoderPort(instanceId);
        const udpSink = endpoint
            ? `udpsink name=usink host=${endpoint.host} port=${endpoint.port} multicast-iface=lo auto-multicast=true buffer-size=2097152 sync=false`
            : 'fakesink name=usink sync=false';

        let tail: string;
        switch (codec) {
            case 'aac':
                tail = `audioconvert ! avenc_aac bitrate=${bitrate * 1000} aac-is=false aac-ms=false ! mpegtsmux latency=0 alignment=7 ! ${udpSink}`;
                break;
            case 'opus':
            default: {
                const frameSize = (config.frameSize as number) ?? 20;
                const inbandFec = (config.inbandFec as boolean) ?? true;
                const packetLoss = (config.packetLoss as number) ?? 10;
                // Use restricted-lowdelay for frame sizes <= 5ms
                const audioType = frameSize <= 5 ? 'audio-type=restricted-lowdelay' : '';
                tail = `opusenc bitrate=${bitrate * 1000} frame-size=${frameSize} dtx=false inband-fec=${inbandFec} packet-loss-percentage=${packetLoss} ${audioType} ! mpegtsmux latency=0 alignment=7 ! ${udpSink}`.replace(/  +/g, ' ');
                break;
            }
        }
        const parts = [source, format, vol, level, tail].filter(Boolean);
        const pipeline = parts.join(' ! ');

        return {
            pipeline,
            liveElements: {
                vol: ['volume'],
            },
        };
    }
}

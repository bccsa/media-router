import {
    GstPluginBase,
    ThroughputPoller,
    bitrateBadge,
    buildUdpSink,
    busTransport,
    busTeeName,
    gstInspectMaxChannels,
    type PipelineDescription,
    type ModuleServices,
    type ThroughputSample,
} from '@media-router/engine';

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

    /** Bus egress element to poll for throughput, resolved at build time: the
     *  fan-out `tee` (busTeeName) under unixfd, the `usink` udpsink under UDP. */
    private busSinkName: string | undefined;

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
                this.services.instanceId,
                channels,
                rate,
                this.services.instanceId,
            );
            // Force 100% volume — PulseAudio's stream-restore may remember 0% from a previous session
            await this.services.pipeWire.setSinkVolume(this.pwNodeName, 100);
        }

        await super.onStart();
        this.updateStatusData();

        // Poll udpsink bytes-served every 2s for live throughput stats.
        this.throughput.start();
    }

    /** Output-bitrate poller on the udpsink. */
    private readonly throughput = new ThroughputPoller({
        getBytes: () => this.readSinkBytes(),
        publish: (sample) => this.publishThroughput(sample),
    });

    private async readSinkBytes(): Promise<number | undefined> {
        return this.busSinkName ? this.readBusSinkBytes(this.busSinkName) : undefined;
    }

    private publishThroughput(sample: ThroughputSample): void {
        this.setStatusData('throughput', {
            'Output Bitrate': `${sample.bitrateKbps} kbps`,
            'Total Bytes': `${(sample.totalBytes / 1024 / 1024).toFixed(1)} MB`,
        });
        this.setBadge('bitrate', bitrateBadge(sample.bitrateKbps));
    }

    private updateStatusData(): void {
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getUdpEndpoint(instanceId);
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
        this.throughput.stop();
        await super.onStop();
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            // Volume controlled via GStreamer element only — no pactl to avoid double-attenuation
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => {
                this.log.debug({ err }, 'Volume update failed (pipeline may not be running)');
            });
        }
        if ('bitrate' in changes) {
            const codec = (this.config.codec as string) ?? 'opus';
            const elementName = codec === 'aac' ? 'avenc_aac0' : 'opusenc0';
            await this.setElementProperty(
                elementName,
                'bitrate',
                (changes.bitrate as number) * 1000,
            );
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
        // Respect audioEnabled on start — otherwise a muted module unmutes
        // itself when restarted (gst volume element starts at config.volume).
        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const gstVolume = (volumePct / 100).toFixed(2);

        // Read from our null-sink's monitor
        const source = `pulsesrc device=${this.pwNodeName}.monitor`;
        const format = `audioconvert ! audioresample ! audio/x-raw,rate=${sampleRate},channels=${channels}`;
        const vol = `volume name=vol volume=${gstVolume}`;
        const level =
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000';
        // Leaky queue absorbs encoder/network back-pressure — without this,
        // pulsesrc backs up and audio latency grows over hours (v1 hit this
        // and added the same queue in commit 767f531).
        const encoderQueue = 'queue max-size-time=50000000 leaky=2 flush-on-eos=true';

        // Encoder always gets a UDP multicast port assigned at startup.
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.assignUdpPort(instanceId);
        this.busSinkName = endpoint
            ? busTransport() === 'unixfd'
                ? busTeeName(endpoint.port)
                : 'usink'
            : undefined;
        const udpSink = endpoint
            ? buildUdpSink({ name: 'usink', host: endpoint.host, port: endpoint.port })
            : 'fakesink name=usink sync=false';

        const tsAlignment = (config.tsAlignment as number) ?? 7;
        let tail: string;
        switch (codec) {
            case 'aac':
                // Force plain L/R stereo: disable intensity (aac-is) and M/S
                // (aac-ms) joint-stereo coding so independent-channel broadcast
                // feeds aren't blended. Use `0` not `false` — newer gst-libav
                // exposes aac-ms as a tri-state enum (auto/off/on), where the
                // literal `false` fails to deserialize (issue #676). `0` means
                // "off" on the enum and "false" on builds that keep it boolean.
                tail = `audioconvert ! avenc_aac bitrate=${bitrate * 1000} aac-is=0 aac-ms=0 ! mpegtsmux latency=0 alignment=${tsAlignment} ! ${udpSink}`;
                break;
            case 'opus':
            default: {
                const frameSize = (config.frameSize as number) ?? 20;
                const inbandFec = (config.inbandFec as boolean) ?? false;
                const packetLoss = (config.packetLoss as number) ?? 10;
                // `audioType=0` is the "Auto" sentinel — not a real Opus value
                // (real ones are 2048/2049/2051). It picks restricted-lowdelay
                // for low-latency configs (frame size ≤ 5 ms) and generic
                // otherwise, matching the pre-`audioType` behaviour and what
                // v1 receivers expect for low latency.
                const rawAudioType = config.audioType as number | undefined;
                const audioType =
                    rawAudioType && rawAudioType !== 0
                        ? rawAudioType
                        : frameSize <= 5
                          ? 2051
                          : 2048;
                tail =
                    `opusenc bitrate=${bitrate * 1000} frame-size=${frameSize} dtx=false inband-fec=${inbandFec} packet-loss-percentage=${packetLoss} audio-type=${audioType} ! mpegtsmux latency=0 alignment=${tsAlignment} ! ${udpSink}`.replace(
                        /  +/g,
                        ' ',
                    );
                break;
            }
        }
        const parts = [source, format, vol, level, encoderQueue, tail].filter(Boolean);
        const pipeline = parts.join(' ! ');

        return {
            pipeline,
        };
    }
}

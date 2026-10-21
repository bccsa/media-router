import {
    GstPluginBase,
    INGEST_OFFSET_KEY,
    IngestTimingReporter,
    ThroughputPoller,
    applyIngestTimingLiveUpdate,
    asrcBusReports,
    bitrateBadge,
    buildAsrc,
    buildBusSink,
    buildRestamp,
    busTeeName,
    gstInspectMaxChannels,
    isIngestTimingSection,
    pulsePinnedStreamProps,
    restampBusReports,
    type IngestTimingHost,
    type PipelineDescription,
    type ModuleServices,
    type ThroughputSample,
} from '@media-router/engine';

/** Encoder bitrate bounds in kbps per codec; the manifest's bitrate
 *  minimum/maximum/x-maxBy mirror this table (asserted in the tests). */
export const BITRATE_KBPS: Record<string, { min: number; max: number; default: number }> = {
    opus: { min: 6, max: 510, default: 128 },
    aac: { min: 32, max: 320, default: 128 },
};

/** Clamp an operator bitrate (kbps) to the codec's range (#664); unset/junk/≤0 → default. */
export function clampBitrateKbps(codec: string, kbps: unknown): number {
    const r = BITRATE_KBPS[codec] ?? BITRATE_KBPS.opus;
    const n = Math.round(Number(kbps));
    if (!Number.isFinite(n) || n <= 0) return r.default;
    return Math.min(r.max, Math.max(r.min, n));
}

/** `srcBufferMs`: the requested PipeWire quantum, in the manifest's 40–85 ms (OQ-16). */
export const SRC_BUFFER_MS = { min: 40, max: 85, default: 60 };

/** GStreamer's fallback layout per channel count (gst_audio_channel_get_fallback_mask). */
const CAPTURE_CHANNEL_MASKS: Record<number, string> = {
    2: '0x3',
    3: '0xb',
    4: '0x33',
    5: '0x37',
    6: '0x3f',
    7: '0x13f',
    8: '0xc3f',
};

/**
 * Audio Encoder plugin.
 *
 * Creates a named null-sink that other modules feed into via loopback.
 * Reads from the null-sink's monitor, encodes to Opus/AAC, muxes into MPEG-TS,
 * and fans it out on the bus. On house time (house-clock plan WI-P1-12): the
 * capture carries the PipeWire driver's timing, `mrasrc` resamples it once to
 * `sampleRate`, the restamp applies the Ingest Offset and the egress is identity.
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

    /** O is the restamp's live property (§5.5); a capture has no per-PID trim (OQ-15). */
    protected liveUpdatableParams = ['bitrate', 'volume', 'audioEnabled', INGEST_OFFSET_KEY];

    /** Bus egress element to poll for throughput, resolved at build time:
     *  the fan-out `tee` (busTeeName). */
    private busSinkName: string | undefined;

    /** The ASRC's and the restamp's card: the Clock section and part 10's warnings. */
    private readonly ingestTiming = new IngestTimingReporter(this.ingestTimingHost(), {
        mode: 'fixed',
    });
    /** The reporter's warning text, so its clear never takes another warning down. */
    private clockWarning: string | null = null;

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
        this.ingestTiming.start();
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
        const endpoint = this.services?.mediaRouter?.getBusChannel(instanceId);
        const codec = (this.config.codec as string) ?? 'opus';
        this.setStatusData('encoder', {
            codec,
            bitrate: clampBitrateKbps(codec, this.config.bitrate),
            frameSize: (this.config.frameSize as number) ?? 20,
            sampleRate: (this.config.sampleRate as number) ?? 48000,
            channels: (this.config.channels as number) ?? 2,
        });
        this.setStatusData('bus', {
            channel: endpoint?.port ?? 0,
        });
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        this.ingestTiming.stop();
        await super.onStop();
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
        if ('bitrate' in changes) {
            const codec = (this.config.codec as string) ?? 'opus';
            const elementName = codec === 'aac' ? 'avenc_aac0' : 'opusenc0';
            await this.setElementProperty(
                elementName,
                'bitrate',
                clampBitrateKbps(codec, changes.bitrate) * 1000,
            );
        }
        await applyIngestTimingLiveUpdate(
            { setElementProperty: (e, p, v) => this.setElementProperty(e, p, v) },
            changes,
        );
        this.updateStatusData();
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        this.ingestTiming.onEvent(channel, payload);
    }

    /** Every PLAYING sets health ok: put a standing clock warning back. */
    protected onPipelinePlaying(): void {
        this.ingestTiming.reassert();
    }

    /** A return to ok shows a standing clock warning again: another warning may have hidden it. */
    setHealth(...args: Parameters<GstPluginBase['setHealth']>): void {
        super.setHealth(...args);
        if (args[0] === 'ok') this.ingestTiming.reassert();
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Audio sources loopback into our null-sink
        return { sink: this.pwNodeName };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription {
        const codec = (config.codec as string) ?? 'opus';
        const bitrate = clampBitrateKbps(codec, config.bitrate);
        const sampleRate = (config.sampleRate as number) ?? 48000;
        const channels = (config.channels as number) ?? 2;
        // Respect audioEnabled on start — otherwise a muted module unmutes
        // itself when restarted (gst volume element starts at config.volume).
        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const gstVolume = (volumePct / 100).toFixed(2);

        const source = this.buildCapture(channels, config.srcBufferMs);
        // The one resample of the path (§13.1): the device's rate to `sampleRate`, as a
        // sample counter labelled with capture time (P7).
        const format = `audioconvert ! ${buildAsrc({ outRate: sampleRate })} ! audio/x-raw,rate=${sampleRate},channels=${channels}`;
        const vol = `volume name=vol volume=${gstVolume}`;
        const level =
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000';
        // Leaky queue absorbs encoder/network back-pressure — without this,
        // the capture backs up and audio latency grows over hours (v1 hit this
        // and added the same queue in commit 767f531).
        const encoderQueue = 'queue max-size-time=50000000 leaky=2 flush-on-eos=true';

        // Encoder always gets a bus channel assigned at startup.
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.assignBusChannel(instanceId);
        this.busSinkName = endpoint ? busTeeName(endpoint.port) : undefined;
        const udpSink = endpoint ? buildBusSink(endpoint.port) : 'fakesink name=usink sync=false';

        const tsAlignment = (config.tsAlignment as number) ?? 7;
        // The PES carry capture time, so the restamp only moves them by O (part 4.2's fixed mode).
        const restamp = buildRestamp({ mode: 'fixed', offsetMs: config[INGEST_OFFSET_KEY] });
        const egress = `mpegtsmux latency=0 alignment=${tsAlignment} ! ${restamp} ! ${udpSink}`;
        let tail: string;
        switch (codec) {
            case 'aac':
                // Force plain L/R stereo: disable intensity (aac-is) and M/S
                // (aac-ms) joint-stereo coding so independent-channel broadcast
                // feeds aren't blended. Use `0` not `false` — newer gst-libav
                // exposes aac-ms as a tri-state enum (auto/off/on), where the
                // literal `false` fails to deserialize (issue #676). `0` means
                // "off" on the enum and "false" on builds that keep it boolean.
                tail = `audioconvert ! avenc_aac bitrate=${bitrate * 1000} aac-is=0 aac-ms=0 ! ${egress}`;
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
                    `opusenc bitrate=${bitrate * 1000} frame-size=${frameSize} dtx=false inband-fec=${inbandFec} packet-loss-percentage=${packetLoss} audio-type=${audioType} ! ${egress}`.replace(
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
            busReports: [...restampBusReports(), ...asrcBusReports()],
        };
    }

    /**
     * `pipewiresrc` on the null-sink's monitor: its buffers carry the PipeWire driver's cycle
     * time, the device timing `mrasrc` locks to. `srcBufferMs` is the requested graph quantum,
     * clamped as audio-input-302m clamps it (85 ms = the image's quantum-limit 4096).
     */
    private buildCapture(channels: number, srcBufferMs: unknown): string {
        const asked = Number(srcBufferMs ?? SRC_BUFFER_MS.default);
        const ms = Number.isFinite(asked) ? asked : SRC_BUFFER_MS.default;
        const quantum = Math.round(
            Math.max(SRC_BUFFER_MS.min, Math.min(SRC_BUFFER_MS.max, ms)) * 48,
        );
        const src =
            `pipewiresrc target-object=${this.pwNodeName}` +
            ` ${pulsePinnedStreamProps({
                'stream.capture.sink': 'true',
                'node.latency': `${quantum}/48000`,
            })}`;
        // Pinned: an open format hung PipeWire 1.2.7's negotiation under opusenc, an open count
        // may come back downmixed, and GStreamer reads over two channels only with a mask.
        const mask = CAPTURE_CHANNEL_MASKS[channels];
        return (
            `${src} ! audio/x-raw,format=F32LE,channels=${channels}` +
            (mask ? `,channel-mask=(bitmask)${mask}` : '')
        );
    }

    private ingestTimingHost(): IngestTimingHost {
        return {
            // The base keeps one list of dynamic sections: anyone else's stay.
            setDynamicSections: (sections) => {
                const others = this.dynamicStatusSections.filter(
                    (s) => !isIngestTimingSection(s.id),
                );
                this.setDynamicSections([...others, ...sections]);
            },
            setStatusData: (id, data) => this.setStatusData(id, data),
            setBadge: (id, badge) => this.setBadge(id, badge),
            clearBadge: (id) => this.clearBadge(id),
            setFieldOptions: (key, options) => this.setFieldOptions(key, options),
            // Over ok or another warning, never over a fault or a stop: PLAYING re-asserts it.
            warn: (text) => {
                this.clockWarning = text;
                if (this.health === 'ok' || this.health === 'warning') {
                    this.setHealth('warning', text);
                }
            },
            clearWarning: () => {
                if (this.health === 'warning' && this.error === this.clockWarning) {
                    this.setHealth('ok');
                }
                this.clockWarning = null;
            },
            log: (level, obj, msg) => this.log[level](obj, msg),
        };
    }
}

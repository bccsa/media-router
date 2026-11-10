import {
    DECODE_BYPASS_PPM,
    GstPluginBase,
    OUTPUT_RING_US,
    buildAsrc,
    buildBusDemux,
    buildLatenessTap,
    buildOutputPrefill,
    pulsePinnedStreamProps,
    tsQueueByteCap,
    type PipelineDescription,
    type ModuleServices,
    probeMpegTsStream,
    type ProbeResult,
} from '@media-router/engine';

/** `name=` of this leg's demux: its counters on the module's input. */
const DEMUX_NAME = 'addemux';
/** `name=` of this leg's ASRC: the source's clock term and the sink's, one resampler (OQ-23). */
const ASRC_NAME = 'asrc';
/** The compressed queue after the demux: a stall's backlog waits here until a gap (part 4.4). */
const ES_QUEUE_MS = 5000;

/**
 * Audio Decoder plugin.
 *
 * Receives MPEG-TS via UDP multicast (from an encoder or SRT source),
 * probes the stream to detect the codec, then builds the appropriate
 * decode pipeline for its first audio stream. Outputs PCM to a named null-sink.
 *
 * TIMING (house-clock part 4.1, B-168). It plays as soon as it can: a content-time input, a 40 ms
 * prefill and a `sync=false` sink on a 100 ms ring (`outputSink.ts`); no playout offset, no trim.
 *
 * CLOCKS (house-clock part 4.4). `asrc` resamples a source on a clock of its own to house rate
 * where it is decoded, and follows the null sink's clock, read on a timer (B-166): one
 * resampler for both terms (OQ-23), and the sink never drops or repeats samples for drift.
 */
export class AudioDecoderModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    /** Probed stream info — plugin decides what to do with it. */
    private probeResult: ProbeResult | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);

        // 1. Probe the stream for codec (and channels if available — opus includes it, AAC doesn't)
        if (udpSource) {
            this.probeResult = await probeMpegTsStream(udpSource.port, 3000, udpSource.socketPath);
            // Once per start; the probe itself logs nothing (B-201), so its caps go here.
            this.log.info(
                {
                    codec: this.probeResult.codec,
                    channels: this.probeResult.channels,
                    rawCaps: this.probeResult.rawCaps || undefined,
                },
                'Stream probe',
            );
        } else {
            this.probeResult = null;
        }

        // 2. Resolve channel count from multiple sources (first available wins):
        //    - Stream probe caps (reliable for opus, unavailable for AAC/ADTS)
        //    - Upstream encoder config (available after encoder starts — getModuleBusSource reads it)
        //    - Stored decoder config (from previous run's emitConfigUpdate)
        //    - Default: 2
        const probedCh = this.probeResult?.channels;
        const encoderCh = udpSource?.channels;
        const storedCh = this.config.channels as number | undefined;
        const channels = probedCh ?? encoderCh ?? storedCh ?? 2;
        const rate = this.probeResult?.sampleRate ?? (this.config.sampleRate as number) ?? 48000;
        this.log.info(
            { probedCh, encoderCh, storedCh, resolved: channels, rate },
            'Channel resolution',
        );

        // 3. Create null-sink with resolved channel count
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

        // 4. Update config and notify UI if changed
        if (channels !== storedCh) {
            this.emitConfigUpdate({ channels });
        }

        await super.onStart();
    }

    async onStop(): Promise<void> {
        await super.onStop();
        this.probeResult = null;
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Other modules read from our null-sink's monitor
        return { source: `${this.pwNodeName}.monitor` };
    }

    /** Its ASRC's device term drains the output's built-up latency (WI-P4-18). */
    drainElementNames(): string[] {
        return [ASRC_NAME];
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        // Respect audioEnabled on start — otherwise a muted module unmutes
        // itself when restarted (gst volume element starts at config.volume).
        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const gstVolume = (volumePct / 100).toFixed(2);

        // Check if we have a UDP source assigned by MediaRouter
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);

        if (!udpSource) {
            this.setHealth('warning', 'No encoder connected');
            return null;
        }

        // `media=audio`: the first audio stream only (OQ-28), so an A/V input never links its
        // video here.
        const busDemux = buildBusDemux({
            port: udpSource.port,
            socketPath: udpSource.socketPath,
            name: DEMUX_NAME,
            media: 'audio',
        });

        // Plugin decides decoder based on probe result.
        //
        // Each decoder is fed straight off a demux src pad, which emits
        // *unframed* elementary streams (one PES per buffer). These software
        // decoders need whole, framed access units, so a codec parser MUST sit
        // between the demux and the decoder — without it `avdec_aac` errors
        // "Input buffer exhausted before END element found" on every buffer and
        // the pipeline crash-loops (seen on a clean single-AAC RIST feed:
        // null-sink idle, gst-runner flapping). The `default` (decodebin) branch
        // is safe because decodebin auto-plugs the parser; the explicit branches
        // must add it themselves. opus is the exception — the demux already
        // emits muxer/decoder-ready opus caps, so opusdec needs no parser.
        let decoder: string;
        switch (this.probeResult?.codec) {
            case 'opus':
                decoder = 'opusdec';
                break;
            case 'aac':
                decoder = 'aacparse ! avdec_aac';
                break;
            case 'mp2':
                decoder = 'mpegaudioparse ! mpg123audiodec';
                break;
            case 'ac3':
                decoder = 'ac3parse ! a52dec';
                break;
            default:
                decoder = 'decodebin';
                break; // fallback for unknown
        }

        const parts = [
            // Non-leaky (part 4.4): PES bursts and a stall's backlog wait here, compressed, and
            // nothing is dropped for lateness; the byte cap bounds it whatever its stamps (ADR-0015).
            `${busDemux} ! queue name=ad_esq leaky=0 max-size-time=${ES_QUEUE_MS * 1_000_000} max-size-buffers=0 max-size-bytes=${tsQueueByteCap(ES_QUEUE_MS)} ! ${decoder}`,
            // Interleaved for `asrc` (avdec_aac's output is planar). Render lateness is read
            // before it, where PTS is still content time (part 4.4).
            'audioconvert',
            buildLatenessTap('lat_render'),
            buildAsrc({ name: ASRC_NAME, bypassBelowPpm: DECODE_BYPASS_PPM, deviceSink: 'sink' }),
            'audioconvert',
            `volume name=vol volume=${gstVolume}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            buildOutputPrefill(),
            // `name=sink` is what `asrc`'s device term follows. It writes each sample as it comes
            // (sync=false): no ts-offset, nothing late to drop.
            `pulsesink name=sink device=${this.pwNodeName} sync=false provide-clock=false processing-deadline=100000000 buffer-time=${OUTPUT_RING_US} ${pulsePinnedStreamProps()}`,
        ];
        const pipeline = parts.filter((p) => p).join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            timingSink: { element: 'sink', kind: 'audio' },
        };
    }
}

/**
 * Pure pipeline-assembly helpers for the audio transcoder.
 *
 * PTS-preservation is THE design requirement here: everything stays inside
 * one GStreamer pipeline, so decoded buffers carry the source timeline
 * (302M/source PES PTS) straight into the encoders — no `pulsesrc`, no
 * `do-timestamp`, no `tsparse set-timestamps` anywhere. This is what removes
 * the PipeWire loop's 290–330 ms re-stamped dwell (and its per-restart
 * anchor lottery) from downstream A/V sync.
 */

import {
    buildAudioMixInput,
    buildUdpSink,
    buildUdpSrc,
    busTeeName,
    busTransport,
    build302mEncodeBranch,
    type AudioMixSource,
} from '@media-router/engine';
import type { AudioTranscoderOutput } from './audioTranscoderPorts.js';

export interface MpegTsFrontEnd {
    mode: 'mpegts';
    host: string;
    port: number;
    socketPath?: string;
    /** Probed source codec — picks the parser+decoder chain. */
    probedCodec?: string;
    /** Post-demux non-leaky dejitter bound (ms). Keep LOW: there is no
     *  real-time sink in the encode path, so this queue's standing fill is
     *  pure arrival latency at downstream muxers (trapped fill in a
     *  non-leaky queue never drains — in-rate = out-rate). */
    bufferMs: number;
}

export interface MixFrontEnd {
    mode: 'mix';
    sources: AudioMixSource[];
    latencyMs: number;
}

export interface AudioTranscoderPipelineInputs {
    frontEnd: MpegTsFrontEnd | MixFrontEnd;
    outputs: AudioTranscoderOutput[];
    channels: number;
    volume: number; // 0..1.5 gst scale
    tsAlignment: number;
}

export interface AudioTranscoderPipelineResult {
    pipeline: string;
    /** Throughput counter elements, index-aligned with `renditionIndex` (the
     *  fan-out tee under unixfd, the named udpsink under UDP). */
    sinks: Array<{ sinkName: string; renditionIndex: number }>;
}

/**
 * Parser+decoder chain for a probed source codec — same mapping as the
 * audio-decoder. Each libav decoder is fed straight off a `tsdemux` src pad,
 * which emits UNFRAMED elementary streams: a codec parser MUST sit between
 * tsdemux and the decoder or `avdec_aac`/`a52dec` crash-loop on every buffer
 * ("Input buffer exhausted before END element found"). Opus is the exception
 * (tsdemux emits decoder-ready caps); `decodebin` auto-plugs its own parser.
 */
export function decoderChainFor(codec: string | undefined): string {
    switch (codec) {
        case 'opus':
            return 'opusdec';
        case 'aac':
            return 'aacparse ! avdec_aac';
        case 'mp2':
            return 'mpegaudioparse ! mpg123audiodec';
        case 'ac3':
            return 'ac3parse ! a52dec';
        case 's302m':
            return 'avdec_s302m';
        default:
            return 'decodebin';
    }
}

/** Opus/AAC encode tail for one rendition (same element settings as the
 *  audio-encoder — see issue #676 for the aac-is/aac-ms integer form).
 *
 *  `perfect-timestamp=true` (GstAudioEncoder) on the lossy encoders: output
 *  timestamps come from the SAMPLE COUNT, not from upstream buffer stamps.
 *  A live `tsdemux` upstream skew-corrects every timestamp against packet
 *  ARRIVAL, so arrival ripple becomes PES-PTS jitter in the re-encoded TS
 *  (measured ±0.45 ms on ~45 % of opus frames on .211) — inaudible to
 *  sample-counting decoders (ffmpeg) but re-exposed as RTP timestamp jitter
 *  by TS→WebRTC gateways, where jitter-buffer time-warping makes speech
 *  sound scratchy/scrambled. The PCM stream is gapless, so sample-count
 *  stamping is exact; genuine gaps beyond the 40 ms base-class tolerance
 *  still resync. */
function encodeTail(r: AudioTranscoderOutput['rendition'], tsAlignment: number): string {
    if (r.codec === 'aac') {
        return `audioconvert ! avenc_aac perfect-timestamp=true bitrate=${r.bitrate * 1000} aac-is=0 aac-ms=0 ! mpegtsmux latency=0 alignment=${tsAlignment}`;
    }
    if (r.codec === 'pcm') {
        return build302mEncodeBranch();
    }
    const frameSize = r.frameSize ?? 20;
    const inbandFec = r.inbandFec ?? false;
    const packetLoss = r.packetLoss ?? 10;
    // audioType=0 is the "Auto" sentinel: restricted-lowdelay for low-latency
    // frame sizes, generic otherwise (matches the audio-encoder).
    const audioType =
        r.audioType && r.audioType !== 0 ? r.audioType : frameSize <= 5 ? 2051 : 2048;
    return (
        `opusenc perfect-timestamp=true bitrate=${r.bitrate * 1000} frame-size=${frameSize} dtx=false` +
        ` inband-fec=${inbandFec} packet-loss-percentage=${packetLoss} audio-type=${audioType}` +
        ` ! mpegtsmux latency=0 alignment=${tsAlignment}`
    );
}

/**
 * Assemble the full pipeline: front-end → shared trunk (convert, volume, VU
 * level, tee) → one encode leaf per rendition.
 */
export function buildPipeline(
    input: AudioTranscoderPipelineInputs,
): AudioTranscoderPipelineResult | null {
    if (input.outputs.length === 0) return null;

    let frontEnd: string;
    if (input.frontEnd.mode === 'mpegts') {
        const fe = input.frontEnd;
        const src = buildUdpSrc({
            host: fe.host,
            port: fe.port,
            bufferSize: 262_144,
            socketPath: fe.socketPath,
        });
        const bufferNs = Math.max(50, Math.min(5000, fe.bufferMs)) * 1_000_000;
        frontEnd =
            `${src} ! tsdemux latency=0` +
            ` ! queue leaky=0 max-size-time=${bufferNs} max-size-buffers=0 max-size-bytes=0` +
            ` ! ${decoderChainFor(fe.probedCodec)}`;
    } else {
        const { fragment, mixerName } = buildAudioMixInput({
            sources: input.frontEnd.sources,
            channels: input.channels,
            latencyMs: input.frontEnd.latencyMs,
        });
        frontEnd = `${fragment} ${mixerName}.`;
    }

    const trunk =
        `audioconvert ! volume name=vol volume=${input.volume.toFixed(2)}` +
        ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ' ! tee name=t';

    const sinks: AudioTranscoderPipelineResult['sinks'] = [];
    const leaves = input.outputs.map((out, i) => {
        // NON-leaky leaf queue, sized well past one source PES batch. The
        // decoder releases audio in bursts (~150 ms of 21 ms buffers at once —
        // source muxers batch audio PES), so a small leaky queue here sheds
        // most of every burst: measured on gate01 as severe stutter on every
        // rendition. The audio-encoder's 50 ms leaky leaf is NOT the right
        // template — its input is a real-time pulsesrc trickle. Non-leaky is
        // latency-free and deadlock-free in this pipeline: encoders drain at
        // CPU speed (≫ real-time) and the bus fan-out tee never blocks, so
        // back-pressure only holds the tee for the burst's processing time.
        const leafQueue =
            'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0 flush-on-eos=true';
        const sink = buildUdpSink({ name: `usink_${i}`, host: out.host, port: out.port });
        sinks.push({
            sinkName: busTransport() === 'unixfd' ? busTeeName(out.port) : `usink_${i}`,
            renditionIndex: i,
        });
        return `t. ! ${leafQueue} ! ${encodeTail(out.rendition, input.tsAlignment)} ! ${sink}`;
    });

    const pipeline = `${frontEnd} ! ${trunk} ${leaves.join(' ')}`;
    return { pipeline, sinks };
}

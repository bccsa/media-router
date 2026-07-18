import { buildUdpSrc } from './udpHelpers.js';

/**
 * SMPTE-302M (PCM-in-MPEG-TS) pipeline helpers — the PTS-preserving audio
 * transport that replaces PipeWire between modules.
 *
 * Why 302M: raw PCM packed in a standard transport stream keeps the source
 * timeline (PES PTS) end-to-end — unlike the PipeWire loop, whose capture
 * side re-stamps audio and turns every millisecond of loop dwell into
 * audio-late A/V skew (measured 290–330 ms on gate01, plus a per-restart
 * anchor lottery). As valid MPEG-TS it also rides SRT/RIST/IP outputs
 * unchanged for inter-device PCM.
 *
 * PTS-preservation contract for everything built here: no `pulsesrc`, no
 * `do-timestamp`, no `tsparse set-timestamps` anywhere in the chain — the
 * 302M PES PTS is the timeline.
 *
 * Runtime requirement: gst-libav `avenc_s302m`/`avdec_s302m` (present on
 * 1.22+) AND mpegts mux/demux support for `audio/x-smpte-302m` (gst ≥ 1.26 —
 * fleet runs 1.28; older dev runtimes can only exercise these strings in
 * unit tests). 302M itself is 48 kHz-only.
 */

export interface AudioMixSource {
    host: string;
    port: number;
    /** Per-consumer unixfd edge socket (undefined on UDP transport). */
    socketPath?: string;
    connectionId: string;
}

export interface AudioMixInputOpts {
    sources: AudioMixSource[];
    /** Output channel count of the mix (inputs are converted). Default 2. */
    channels?: number;
    /** audiomixer latency budget in ms — how long the aggregator waits for
     *  lagging inputs before emitting (silence-filling starved pads).
     *  Default 200, clamped 50–2000. */
    latencyMs?: number;
    /** Element name of the audiomixer. Default 'mixin'. */
    mixerName?: string;
    /** Per-branch post-decode queue bound in ms. Default 100. */
    branchQueueMs?: number;
}

/**
 * N × 302M inputs → one `audiomixer` — the gst-native replacement for
 * PipeWire's implicit summing when multiple sources are wired to one input
 * pin. audiomixer aggregates by RUNNING TIME, so same-timeline inputs mix
 * content-aligned and the output carries coherent PTS.
 *
 * - `force-live=true` (construct-only): the aggregator emits on its latency
 *   deadline regardless of upstream liveness, silence-filling starved pads —
 *   a dark input degrades the mix to silence instead of stalling it.
 * - The `audio/x-smpte-302m` capsfilter after each tsdemux steers pad
 *   selection AND makes wrong-content wiring (an arbitrary TS connected to
 *   an audio pin via TS-family compatibility) fail soft: the pad never
 *   links, the branch stays silent, the runner logs a warning.
 *
 * Returns the pipeline fragment (mixer first, then one branch per source
 * ending in `! <mixerName>.`) — the caller continues the chain from
 * `<mixerName>.` output, e.g. `${fragment} ${mixerName}. ! audioconvert ! …`.
 */
export function buildAudioMixInput(opts: AudioMixInputOpts): {
    fragment: string;
    mixerName: string;
} {
    const channels = opts.channels ?? 2;
    const latencyNs = Math.max(50, Math.min(2000, opts.latencyMs ?? 200)) * 1_000_000;
    const mixerName = opts.mixerName ?? 'mixin';
    const branchQueueNs = Math.max(20, Math.min(2000, opts.branchQueueMs ?? 100)) * 1_000_000;

    // The mixer's OUTPUT caps are pinned immediately on its src pad: a
    // force-live aggregator fixates its output format at startup, BEFORE any
    // input has delivered caps — left to downstream preference it fixates
    // channels=1 (encoders advertise [1,N]) and then DOWNMIXES every input
    // to mono (measured on gate01: stereo 302M in, mono trunk/VU/encode out).
    // Callers continue the chain from `<returned mixerName>.` — the named
    // capsfilter, not the raw audiomixer.
    const srcName = `${mixerName}_out`;
    const mixer =
        `audiomixer name=${mixerName} force-live=true ` +
        `latency=${latencyNs} min-upstream-latency=${latencyNs}` +
        ` ! capsfilter name=${srcName} caps="audio/x-raw,rate=48000,channels=${channels}"`;

    const branches = opts.sources.map((s) => {
        const src = buildUdpSrc({ host: s.host, port: s.port, socketPath: s.socketPath });
        return (
            `${src} ! tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m` +
            ' ! audioconvert ! audioresample' +
            ` ! audio/x-raw,rate=48000,channels=${channels}` +
            ` ! queue leaky=0 max-size-time=${branchQueueNs} max-size-buffers=0 max-size-bytes=0` +
            ` ! ${mixerName}.`
        );
    });

    return { fragment: [mixer, ...branches].join(' '), mixerName: srcName };
}

export interface Audio302mEncodeOpts {
    /** S32LE → 24-bit 302M (default), S16LE → 16-bit. */
    format?: 'S32LE' | 'S16LE';
}

/**
 * PCM → 302M-in-TS encode tail: `… ! <this> ! <udp/bus sink>`.
 *
 * `avenc_s302m` accepts only S32LE/S16LE at 48 kHz (302M is a 48 kHz
 * standard); stereo is pinned — the encoder's channel ceiling varies by
 * gst-libav build (2 on ≤1.24, re-verify on newer). Ends in its own
 * `mpegtsmux latency=0 alignment=7` (single-ES TS, SRT-aligned) — the
 * caller appends `buildUdpSink(...)`.
 */
export function build302mEncodeBranch(opts: Audio302mEncodeOpts = {}): string {
    const format = opts.format ?? 'S32LE';
    // `strict=experimental`: ffmpeg flags its s302m ENCODER experimental and
    // refuses to run at normal compliance ("Codec is experimental, but
    // settings don't allow…" — verified gate01 gst 1.28). The bitstream it
    // produces is plain standard SMPTE 302M; only the encoder is gated.
    return (
        'audioconvert ! audioresample' +
        ` ! audio/x-raw,format=${format},rate=48000,channels=2` +
        ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7'
    );
}

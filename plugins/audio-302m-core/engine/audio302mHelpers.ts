import {
    buildBusSrc,
    gstElementSupportsCaps,
    probeGstElement,
    type ChannelMapEntry,
} from '@media-router/engine';
import { mixMatrixClause } from './channelMapMatrix.js';

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

/**
 * Probe gst runtime support for 302M-in-TS: the libav encoder AND
 * mpegtsmux accepting `audio/x-smpte-302m` caps (gst ≥ 1.26). Every 302M
 * module runs this once from its static `initManifest` and caches the flag.
 */
export async function probe302mSupport(): Promise<boolean> {
    const [enc, mux] = await Promise.all([
        probeGstElement('avenc_s302m'),
        gstElementSupportsCaps('mpegtsmux', 'audio/x-smpte-302m'),
    ]);
    return enc && mux;
}

export interface AudioMixSource {
    port: number;
    /** Per-consumer unixfd edge socket (falls back to the channel socket). */
    socketPath?: string;
    connectionId: string;
    /**
     * Per-connection channel map (same `ChannelMapEntry[]` the audio/pcm
     * links use) — rendered as an `audioconvert mix-matrix` on this source's
     * decode branch: `matrix[dst][src] = gain ?? 1.0`, unmapped cells 0.
     * mono→stereo fan-out, stereo→mono downmix, channel picking from
     * multichannel, and per-channel gain (which pw-links never honoured)
     * all come out of the same matrix. Absent → default channel conversion.
     */
    channelMap?: ChannelMapEntry[];
    /** Channel count of THIS source's 302M stream (matrix input dimension).
     *  Default 2 — the v1 302M encode branch is stereo-pinned. */
    sourceChannels?: number;
}

export interface PacedMixerOpts {
    /** Element name of the `audiomixer`. */
    name: string;
    /** Aggregation latency budget, nanoseconds (also `min-upstream-latency`). */
    latencyNs: number;
    /** Output caps pinned on the mixer's src pad. */
    caps: string;
    /** Element name of the `identity sync=true` clock pacer — the ONLY element
     *  callers may chain from (branching off the caps pin skips the pacer). */
    pacerName: string;
    /** Name the capsfilter too, when a caller needs to address it. */
    capsName?: string;
}

/**
 * `audiomixer force-live=true ! <caps> ! identity sync=true` — the one shape
 * every 302M aggregation point uses, in one place because the `identity` is a
 * FIX, not a style: see `buildAudioMixInput` below for the measurement. Both
 * the input fan-in here and the n1-mixer's feature mixers build through this,
 * so the pacer can never be dropped from one of them by accident.
 */
export function pacedMixer(opts: PacedMixerOpts): string {
    const caps = opts.capsName ? `capsfilter name=${opts.capsName} caps="${opts.caps}"` : opts.caps;
    return (
        `audiomixer name=${opts.name} force-live=true ` +
        `latency=${opts.latencyNs} min-upstream-latency=${opts.latencyNs}` +
        ` ! ${caps}` +
        ` ! identity name=${opts.pacerName} sync=true`
    );
}

export interface AudioMixInputOpts {
    sources: AudioMixSource[];
    /** Output channel count of the mix (inputs are converted). Default 2. */
    channels?: number;
    /** audiomixer latency budget in ms — how long the aggregator waits for
     *  lagging inputs before emitting (silence-filling starved pads).
     *  Default 200, clamped 50–2000. Unused (and free) in the single-source
     *  arm, which has no aggregator to wait on anything. */
    latencyMs?: number;
    /** Name PREFIX for the fan-in's elements, not an element name: the
     *  continuation point is always `<mixerName>_out` and the mixer arm also
     *  names `<mixerName>` / `<mixerName>_caps`. In the single-source arm no
     *  `audiomixer` exists at all and this only prefixes the terminal
     *  capsfilter. Default 'mixin'. */
    mixerName?: string;
    /** Per-branch post-decode queue bound in ms. Default 100. */
    branchQueueMs?: number;
}

/**
 * N × 302M inputs → one named continuation point — the gst-native replacement
 * for PipeWire's implicit summing when several sources are wired to one input
 * pin. Two topologies, chosen by source count, both ending in an element named
 * `<mixerName>_out`; that name comes back as `continuationName` and is the only
 * thing callers may chain from (`${fragment} ${continuationName}. ! … `), so
 * they stay topology-agnostic. Never hard-code the name.
 *
 * MANY sources (≥ 2) — and the empty case, see below — `audiomixer`:
 * it aggregates by RUNNING TIME, so same-timeline inputs mix content-aligned
 * and the output carries coherent PTS.
 * - `force-live=true` (construct-only): the aggregator emits on its latency
 *   deadline regardless of upstream liveness, silence-filling starved pads —
 *   a dark input degrades the mix to silence instead of stalling it.
 * - `identity sync=true` on the mixer's output is the clock pacer, and it is
 *   load-bearing: force-live keeps producing AFTER every pad has gone EOS (by
 *   design — it can't know a dead input won't come back), and no 302M tail
 *   paces it (the output module ends in `pulsesink sync=false`, producer
 *   modules end in an unsynced bus tee). With nothing to block on, the mixer
 *   generated silence at CPU speed and flooded downstream — `level` message
 *   storms, faster-than-realtime bus traffic, a memory balloon that OOM'd a
 *   fleet box. `identity sync=true` blocks on the pipeline clock, so post-EOS
 *   silence runs at realtime: measured 2026-08-25 on the fleet box (gst
 *   1.28.2), one EOS'd input into an unsynced tail = 11.64 s CPU per 10 s
 *   wall, the same pipeline with the pacer = 0.07 s; reproduced bare on a dev
 *   box, same gst version, at 9.16 s vs 0.03 s per 10 s wall. Healthy flow
 *   keeps its rate — a live stream already advances at clock rate; the pacer
 *   only stops the pipeline running AHEAD of the clock, which costs a one-off
 *   startup offset of about 2 × the mixer latency (measured 0.12 / 0.42 /
 *   1.02 s at latency 50 / 200 / 500 ms) and nothing per buffer after that.
 *   Sink-agnostic by construction, so it holds for every 302M module's tail.
 *   Defaults are right for everything else (`single-segment=false` is
 *   identity's default).
 *
 * ONE source — direct branch, no aggregator and no pacer: a lone input needs
 * no summing, and the mixer only cost it the `latencyMs` aggregation delay
 * (200 ms by default) plus a re-stamped timeline. Trade: no silence-fill, so a
 * dying source EOSes/stalls the module and the runner's restart path takes
 * over instead of the mix degrading to silence — the same behaviour the
 * single-input audio-transcoder has always had. Without a force-live
 * aggregator there is no post-EOS free-run to pace. `latencyMs` is simply
 * unused here.
 *
 * ZERO sources — mixer arm, unchanged: callers that build a pad-less fan-in
 * (and then wire it themselves) keep the force-live mixer they had, now with
 * the pacer, which is exactly the never-fed free-run case above.
 *
 * The `audio/x-smpte-302m` capsfilter after each tsdemux steers pad selection
 * in both arms AND makes wrong-content wiring (an arbitrary TS connected to an
 * audio pin via TS-family compatibility) fail soft: the pad never links, the
 * branch stays silent, the runner logs a warning.
 */
export function buildAudioMixInput(opts: AudioMixInputOpts): {
    fragment: string;
    /** Element to chain from. NOT always a mixer — it is a `capsfilter` in the
     *  single-source arm and the `identity` pacer in the mixer arm. */
    continuationName: string;
} {
    const channels = opts.channels ?? 2;
    const latencyNs = Math.max(50, Math.min(2000, opts.latencyMs ?? 200)) * 1_000_000;
    const mixerName = opts.mixerName ?? 'mixin';
    const branchQueueNs = Math.max(20, Math.min(2000, opts.branchQueueMs ?? 100)) * 1_000_000;

    const outName = `${mixerName}_out`;
    const caps = `audio/x-raw,rate=48000,channels=${channels}`;
    const branchQueue =
        `queue leaky=0 max-size-time=${branchQueueNs} max-size-buffers=0 max-size-bytes=0`;

    /** 302M edge socket → decoded, channel-mapped, resampled raw audio. */
    const decode = (s: AudioMixSource): string => {
        const src = buildBusSrc({ port: s.port, socketPath: s.socketPath });
        // Per-connection channel mapping on THIS branch's audioconvert.
        const matrix = s.channelMap?.length
            ? mixMatrixClause(s.channelMap, s.sourceChannels ?? 2, channels)
            : '';
        return (
            `${src} ! tsdemux latency=0 ! audio/x-smpte-302m ! avdec_s302m` +
            ` ! audioconvert${matrix} ! audioresample`
        );
    };

    if (opts.sources.length === 1) {
        // The output caps sit on the terminal capsfilter (the queue is
        // transparent to negotiation), so the branch pins the same format the
        // mixer arm publishes, with one element fewer.
        const fragment =
            `${decode(opts.sources[0])} ! ${branchQueue}` +
            ` ! capsfilter name=${outName} caps="${caps}"`;
        return { fragment, continuationName: outName };
    }

    // The mixer's OUTPUT caps are pinned immediately on its src pad: a
    // force-live aggregator fixates its output format at startup, BEFORE any
    // input has delivered caps — left to downstream preference it fixates
    // channels=1 (encoders advertise [1,N]) and then DOWNMIXES every input
    // to mono (measured on gate01: stereo 302M in, mono trunk/VU/encode out).
    const mixer = pacedMixer({
        name: mixerName,
        latencyNs,
        caps,
        capsName: `${mixerName}_caps`,
        pacerName: outName,
    });

    const branches = opts.sources.map(
        (s) => `${decode(s)} ! ${caps} ! ${branchQueue} ! ${mixerName}.`,
    );

    return { fragment: [mixer, ...branches].join(' '), continuationName: outName };
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
 * caller appends `buildBusSink(...)`.
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

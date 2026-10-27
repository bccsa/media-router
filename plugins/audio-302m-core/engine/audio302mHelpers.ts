import {
    buildAsrc,
    buildBusSrc,
    gstElementSupportsCaps,
    probeGstElement,
    quoteGstString,
    shortHash,
    type ChannelMapEntry,
    type LiveInputBranch,
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
 * 1.22+) AND `mpegtsmux` support for `audio/x-smpte-302m` (gst ≥ 1.26 —
 * fleet runs 1.28; older dev runtimes can only exercise these strings in
 * unit tests); the fan-in's `mrtsdemux` and `mralignwatch` come from the
 * timing plugin (`libgstmrtshouse.so`). 302M itself is 48 kHz-only.
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
     *  Default 2. Normalised through `normalize302mChannels` before use, since
     *  a 302M stream only ever carries 2/4/6/8 channels whatever the producer's
     *  raw `channels` setting says (a mono-trunk transcoder still emits stereo
     *  302M). `MediaRouter.getModuleBusSources` fills it from the producer's
     *  `getBusStreamChannels` declaration — the wire width, never a config
     *  field. */
    sourceChannels?: number;
    /** The producer's known output lateness at start (ms): its aligner's `seed-lateness`,
     *  a floor of the mixer's pace (house-clock plan WI-P2-13 fills it). */
    seedLatenessMs?: number;
}

/** The channel counts a SMPTE-302M stream can carry (and `avenc_s302m` accepts). */
const S302M_CHANNEL_COUNTS = [2, 4, 6, 8] as const;
type S302mChannels = (typeof S302M_CHANNEL_COUNTS)[number];

/**
 * Snap any channel count onto the 302M set: rounds UP to the next even count
 * and clamps to 2..8 (1→2, 3→4, 5→6, 7→8, ≥9→8, junk→2). 302M has no other
 * layouts — 32 desk inputs mean four 8-channel streams, not one wide one.
 */
export function normalize302mChannels(n: number | undefined): S302mChannels {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 2) return 2;
    if (v >= 8) return 8;
    return (v % 2 === 0 ? v : v + 1) as S302mChannels;
}

export interface AlignedMixerOpts {
    /** Element name of the `audiomixer`. */
    name: string;
    /** Output caps, pinned on the capsfilter after the mixer. */
    caps: string;
    /** Element name of that capsfilter: the element callers chain from. */
    outName: string;
}

/** `audiomixer latency=0 start-time-selection=first ! capsfilter`, every 302M mixer (house-clock
 *  part 4.3). Every pad comes through `mralignwatch`: non-live, so the mixer never times out,
 *  waits for data or a gap on each pad and drops nothing late. */
export function alignedMixer(opts: AlignedMixerOpts): string {
    return (
        `audiomixer name=${opts.name} latency=0 start-time-selection=first` +
        ` ! capsfilter name=${opts.outName} caps="${opts.caps}"`
    );
}

export interface AudioMixInputOpts {
    sources: AudioMixSource[];
    /** Output channel count of the mix (inputs are converted). Default 2. */
    channels?: number;
    /** Name PREFIX for the fan-in's elements, not an element name: the
     *  continuation point is always `<mixerName>_out` and the mixer arm also
     *  names the `audiomixer` `<mixerName>`. In the single-source arm no
     *  `audiomixer` exists at all and this only prefixes the terminal
     *  capsfilter. Default 'mixin'. */
    mixerName?: string;
    /** The single-source arm's post-decode queue bound in ms (default 100,
     *  clamped 20–2000). The mixer arm's inputs queue in `mralignwatch` (5 s). */
    branchQueueMs?: number;
    /** Live-input mode: each source its own named bin on an explicit
     *  `sink_<i>` pad, mixer arm even for ONE source (ADR-0008 addendum).
     *  Default off — classic callers keep byte-identical strings. */
    liveInputs?: boolean;
}

/**
 * Name of the input branch bin for one connection in live-input mode —
 * shared by `buildAudioMixInput` and a module's `getLiveInputBranch`, so a
 * branch built at start can still be found by a later live remove.
 */
export function mixInputBranchName(mixerName: string, connectionId: string): string {
    return `${mixerName}_in_${shortHash(connectionId)}`;
}

export interface MixInputBranchOpts {
    /** Output channel count of the mix (the branch converts to it). Default 2. */
    channels?: number;
    /** The aggregator the branch links into: its watchdog's pace group (`aligner`). */
    mixerName: string;
    /** `name=` of the branch's mrtsdemux. */
    demuxName: string;
}

/** `name=` of a live-input branch's mrtsdemux — keyed by the connection like
 *  the bin, so a branch added later never collides with one built at start. */
export function liveDemuxName(mixerName: string, connectionId: string): string {
    return `${mixerName}_demux_${shortHash(connectionId)}`;
}

/** `name=` of the mrtsdemux decoding `sources[i]`: by its connection in live-input mode, else by
 *  its place. */
function branchDemuxName(
    mixerName: string,
    i: number,
    source: AudioMixSource,
    live: boolean,
): string {
    return live ? liveDemuxName(mixerName, source.connectionId) : `${mixerName}_demux${i}`;
}

/** The live-input branch of ONE wired connection (`getLiveInputBranch` shape).
 *  `buildAudioMixInput` in live-input mode renders every start-time branch
 *  through this too, so a module's hook and its `buildPipeline` agree. */
export function liveMixInputBranch(
    mixerName: string,
    source: AudioMixSource,
    opts: Omit<MixInputBranchOpts, 'mixerName' | 'demuxName'> = {},
): LiveInputBranch {
    return {
        element: mixerName,
        name: mixInputBranchName(mixerName, source.connectionId),
        description: build302mMixBranch(source, {
            ...opts,
            mixerName,
            demuxName: liveDemuxName(mixerName, source.connectionId),
        }),
    };
}

/** A module's `getLiveInputBranch` answer for one edge of `mixerName`: the
 *  full branch while the source is wired, just aggregator + bin name once it
 *  is gone (a remove). */
export function liveInputBranchFor(
    mixerName: string,
    connectionId: string,
    source: AudioMixSource | undefined,
    opts: Omit<MixInputBranchOpts, 'mixerName' | 'demuxName'> = {},
): LiveInputBranch {
    if (!source) return { element: mixerName, name: mixInputBranchName(mixerName, connectionId) };
    return liveMixInputBranch(mixerName, source, opts);
}

/** `seed-lateness` in ns, within the 0..1 h the element takes; none without a seed. */
function seedClause(seedMs: number | undefined): string {
    if (typeof seedMs !== 'number' || !Number.isFinite(seedMs)) return '';
    const ms = Math.min(Math.max(seedMs, 0), 3_600_000);
    return ` seed-lateness=${Math.round(ms * 1_000_000)}`;
}

/** 302M edge → raw audio, on content time: `mrtsdemux` in select mode is the
 *  formula demux (running time = PES PTS − 1 h, house-clock WI-P2-7). */
function decode302m(source: AudioMixSource, demuxName: string, channels: number): string {
    const src = buildBusSrc({ port: source.port, socketPath: source.socketPath });
    // Per-connection channel mapping on THIS branch's audioconvert.
    const matrix = source.channelMap?.length
        ? mixMatrixClause(
              source.channelMap,
              normalize302mChannels(source.sourceChannels ?? 2),
              channels,
          )
        : '';
    return (
        `${src} ! mrtsdemux name=${demuxName} select=audio/x-smpte-302m ! avdec_s302m` +
        ` ! audioconvert${matrix} ! audioresample`
    );
}

/** The input's watchdog (house-clock WI-P2-6): paced with the mixer's other inputs;
 *  silence past W, and EOS (`hold-on-eos`), make it absent and gapped, never a stall. */
function alignWatch(mixerName: string, source: AudioMixSource): string {
    return (
        `mralignwatch name=${mixerName}_aw_${shortHash(source.connectionId)}` +
        ` aligner=${mixerName} input=${quoteGstString(source.connectionId)} hold-on-eos=true` +
        seedClause(source.seedLatenessMs)
    );
}

/** One source's decode branch into an aggregator: 302M edge → content-time raw
 *  audio at the mix caps → its `mralignwatch`, the element whose src pad links
 *  into the aggregator (and the unlinked src pad a live add ghosts). */
export function build302mMixBranch(source: AudioMixSource, opts: MixInputBranchOpts): string {
    const channels = opts.channels ?? 2;
    return (
        `${decode302m(source, opts.demuxName, channels)}` +
        ` ! audio/x-raw,rate=48000,channels=${channels}` +
        ` ! ${alignWatch(opts.mixerName, source)}`
    );
}

/**
 * N × 302M inputs → one named continuation point — the gst-native replacement
 * for PipeWire's implicit summing when several sources are wired to one input
 * pin. Two topologies, chosen by source count, both ending in a capsfilter named
 * `<mixerName>_out`; that name comes back as `continuationName` and is the only
 * thing callers may chain from (`${fragment} ${continuationName}. ! … `), so
 * they stay topology-agnostic. Never hard-code the name.
 *
 * Every branch decodes on content time: `mrtsdemux select=audio/x-smpte-302m` is
 * the formula demux (running time = PES PTS − 1 h, house-clock WI-P2-7), so no
 * branch is aligned to the bus stamps. Wrong content (a TS with no 302M stream)
 * fails soft: the demux posts its `no-stream` message and its pad stays silent.
 *
 * MANY sources (≥ 2), live-input mode and the empty case — `alignedMixer`.
 * `audiomixer` aggregates by RUNNING TIME, so same-timeline inputs mix
 * content-aligned. Each input enters through its `mralignwatch` (house-clock
 * part 4.3, WI-P2-6), which answers LATENCY non-live, so the mixer never times
 * out: it waits for data or a gap on every pad and drops nothing late. The
 * watchdogs of one mixer share a pace, the slowest input's lateness, and release
 * data at running time + pace. An input silent past W, or EOS (`hold-on-eos`), is
 * absent and gapped, so a dark input degrades the mix to silence instead of
 * stalling it. Nothing is force-live, so nothing free-runs after EOS: no pacer.
 * - Non-live also means a `sync=true` sink after this arm adds no latency of its
 *   own, its ring included, unlike after the live single-source arm. A leg that
 *   cancels its sink's ring in `ts-offset` keeps the sink's upstream live
 *   (audio-output-302m).
 * - `start-time-selection=first`: the output starts at the first input's running
 *   time. The default `zero` starts at running time 0, BOOT under base_time=0, and
 *   the mixer would first emit the box's uptime as silence (10.9.16.111,
 *   2026-09-08: 13 min of dead Audio Out after a restart). Non-live, the
 *   aggregator takes the earliest first buffer of all its pads (WI-P2-6).
 *
 * ONE source, not in live-input mode — direct branch, no aggregator and no
 * watchdog (ADR-0008's bypass): a lone input needs no summing. Trade: no
 * silence-fill, so a dying source EOSes/stalls the module and the runner's
 * restart path takes over instead of the mix degrading to silence — the same
 * behaviour the single-input audio-transcoder has always had.
 *
 * ZERO sources — the aligned mixer alone: a caller that wires its own inputs
 * brings each through `mralignwatch` (`build302mMixBranch`); a live pad straight
 * into it would make the mixer live, and it would drop what comes late.
 */
export function buildAudioMixInput(opts: AudioMixInputOpts): {
    fragment: string;
    /** Element to chain from: the terminal capsfilter `<mixerName>_out`, in both arms. */
    continuationName: string;
} {
    const channels = opts.channels ?? 2;
    const mixerName = opts.mixerName ?? 'mixin';
    const live = opts.liveInputs === true;
    const outName = `${mixerName}_out`;
    const caps = `audio/x-raw,rate=48000,channels=${channels}`;

    if (opts.sources.length === 1 && !live) {
        // The output caps sit on the terminal capsfilter (the queue is
        // transparent to negotiation), so the branch pins the same format the
        // mixer arm publishes, with one element fewer.
        const queueNs = Math.max(20, Math.min(2000, opts.branchQueueMs ?? 100)) * 1_000_000;
        const demuxName = branchDemuxName(mixerName, 0, opts.sources[0], false);
        const fragment =
            `${decode302m(opts.sources[0], demuxName, channels)}` +
            ` ! queue leaky=0 max-size-time=${queueNs} max-size-buffers=0 max-size-bytes=0` +
            ` ! capsfilter name=${outName} caps="${caps}"`;
        return { fragment, continuationName: outName };
    }

    // The mixer's OUTPUT caps are pinned right on its src pad: left to downstream
    // preference it fixates channels=1 (encoders advertise [1,N]) and DOWNMIXES
    // every input to mono (measured on gate01: stereo 302M in, mono out).
    const mixer = alignedMixer({ name: mixerName, caps, outName });

    // Live-input mode: each branch is a named bin on an explicit request pad,
    // the exact string a hot add sends — so a later live remove finds it.
    const branches = opts.sources.map((s, i) => {
        if (!live) {
            const demuxName = branchDemuxName(mixerName, i, s, false);
            return `${build302mMixBranch(s, { channels, mixerName, demuxName })} ! ${mixerName}.`;
        }
        const b = liveMixInputBranch(mixerName, s, { channels });
        return `( name=${b.name} ${b.description} ) ! ${mixerName}.sink_${i}`;
    });

    return { fragment: [mixer, ...branches].join(' '), continuationName: outName };
}

/** Which connection each `mrtsdemux` of `buildAudioMixInput(opts)` decodes, by its `name=`: a
 *  module's `demuxInputOf` answer (house-clock WI-P3-6). */
export function mixInputDemuxes(opts: AudioMixInputOpts): Map<string, string> {
    const mixerName = opts.mixerName ?? 'mixin';
    const live = opts.liveInputs === true;
    return new Map(
        opts.sources.map((s, i) => [branchDemuxName(mixerName, i, s, live), s.connectionId]),
    );
}

export interface Audio302mEncodeOpts {
    /** S32LE → 24-bit 302M (default), S16LE → 16-bit. */
    format?: 'S32LE' | 'S16LE';
    /** Channels in the 302M stream — snapped onto {2, 4, 6, 8} by
     *  `normalize302mChannels`. Default 2 (every pre-existing caller). */
    channels?: number;
    /** A PCM capture (house-clock plan WI-P1-11): `mrasrc` in place of `audioresample`, the one
     *  resample of the path, locking the device clock to the capture PTS (P7). */
    asrc?: boolean;
    /** Appended after the mux: the capture's `buildRestamp({ mode: 'fixed', … })`. */
    restamp?: string;
}

/**
 * PCM → 302M-in-TS encode tail: `… ! <this> ! <udp/bus sink>`.
 *
 * `avenc_s302m` accepts only S32LE/S16LE at 48 kHz (302M is a 48 kHz
 * standard) and only 2/4/6/8 channels — that is the format's ceiling, not a
 * build quirk (verified `gst-inspect-1.0 avenc_s302m` on the fleet's gst
 * 1.28.2: `channels: { 2, 4, 6, 8 }`). Default stereo; wider streams are
 * opt-in per caller. Ends in its own `mpegtsmux latency=0 alignment=7`
 * (single-ES TS, SRT-aligned), then the `restamp` when given — the caller
 * appends `buildBusSink(...)`. Without `asrc` and `restamp` (the mixers until
 * Phase 2) the string is the one they have always built.
 */
export function build302mEncodeBranch(opts: Audio302mEncodeOpts = {}): string {
    const format = opts.format ?? 'S32LE';
    const channels = normalize302mChannels(opts.channels ?? 2);
    // No out-rate: the caps after it pin 302M's 48 kHz.
    const resample = opts.asrc ? buildAsrc() : 'audioresample';
    // `strict=experimental`: ffmpeg flags its s302m ENCODER experimental and
    // refuses to run at normal compliance ("Codec is experimental, but
    // settings don't allow…" — verified gate01 gst 1.28). The bitstream it
    // produces is plain standard SMPTE 302M; only the encoder is gated.
    return (
        `audioconvert ! ${resample}` +
        ` ! audio/x-raw,format=${format},rate=48000,channels=${channels}` +
        ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7' +
        (opts.restamp ? ` ! ${opts.restamp}` : '')
    );
}

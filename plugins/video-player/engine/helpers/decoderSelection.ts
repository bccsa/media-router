/**
 * Codec-aware decoder selection for the video-player's LIVE pipeline.
 *
 * WHY NOT decodebin3 EVERYWHERE. `decodebin3` is the safe bootstrap (it plugs
 * whatever the stream turns out to be) but it costs real CPU — parsebin +
 * multiqueue layering ahead of the decoder — and its in-place decoder switching
 * on a mid-stream codec change is fragile: observed on hardware, an h265→h264
 * feed switch left it wedged on software decode still holding a dangling
 * hardware-decoder handle. Once the engine's TS probe has told us the codec, we
 * build the decoder explicitly and rebuild the whole pipeline on a codec change
 * rather than trusting a replug.
 *
 * PURITY. `selectDecoder` takes availability and demotions as data and returns
 * strings — no `gst-inspect`, no filesystem, no module state. Everything that
 * touches the outside world lives in `probeDecoderAvailability`, which the
 * module calls once per engine process from `initManifest` (the probe helper
 * itself is `probeGstElement`, which caches per process). That split is what
 * makes every rung of the ladder testable without a GStreamer install.
 */

/**
 * Every element the ladders can name, in one list so `initManifest` probes
 * exactly what selection may ask about. Parsers are probed too: a rung whose
 * parser is missing is not usable, and on a stripped Yocto image
 * `gstreamer1.0-plugins-bad` (h265parse) is a separate package from the
 * decoder.
 */
export const DECODER_ELEMENTS = [
    'h264parse',
    'v4l2h264dec',
    'avdec_h264',
    'h265parse',
    'v4l2slh265dec',
    'avdec_h265',
] as const;

/** Element name → installed. Absent key is treated as "not installed". */
export type DecoderAvailability = Readonly<Record<string, boolean>>;

/**
 * `name=` given to the decoder on every EXPLICIT rung.
 *
 * Stable across rungs on purpose — hardware and software, h264 and h265 all
 * name the decoder the same thing — so the runner-side keyframe gate can find
 * the pad with ONE element name that doesn't have to be recomputed per rung
 * (see `PipelineDescription.keyframeGate` and `planLivePipeline`). The
 * `decodebin3` rung has no named decoder: the bin plugs it, so there is
 * nothing to name and no gate.
 *
 * KNOCK-ON: naming the element changes what a GStreamer bus error reports as
 * its source (`vpdec` instead of `v4l2slh265dec0`), which is the string the
 * demotion path attributes failures with — `isDecoderElement` in
 * decoderRuntime.ts matches this name as well as the factory-name prefix.
 */
export const VIDEO_DECODER_NAME = 'vpdec';

/** Id of the final rung — `decodebin3`, today's unconditional behaviour. */
export const DECODEBIN_ID = 'decodebin3';

/** One rung of a per-codec ladder, best first. */
export interface DecoderRung {
    /**
     * Stable id — the decoder element name. Doubles as the demotion key, so a
     * decoder that fails at runtime is skipped for the rest of the engine
     * session no matter which module instance hit the failure.
     */
    id: string;
    /** Parser that must precede the decoder (byte-stream → AU framing). */
    parser: string;
    /** Elements that must all be installed for this rung to be selectable. */
    requires: string[];
    /** V4L2/stateless hardware rung — named as such in the demotion note. */
    hardware: boolean;
}

/**
 * Per-codec ladders, best rung first. Anything not listed here (mpeg2, mpeg1,
 * unknown, or "no videoinfo yet") falls straight through to `decodebin3` —
 * unchanged behaviour, which is the point: this feature only ever *adds* a
 * better path for the two codecs the broadcast chain actually carries.
 */
export const DECODER_LADDERS: Readonly<Record<string, readonly DecoderRung[]>> = {
    h264: [
        {
            id: 'v4l2h264dec',
            parser: 'h264parse',
            requires: ['h264parse', 'v4l2h264dec'],
            hardware: true,
        },
        {
            id: 'avdec_h264',
            parser: 'h264parse',
            requires: ['h264parse', 'avdec_h264'],
            hardware: false,
        },
    ],
    h265: [
        {
            id: 'v4l2slh265dec',
            parser: 'h265parse',
            requires: ['h265parse', 'v4l2slh265dec'],
            hardware: true,
        },
        {
            id: 'avdec_h265',
            parser: 'h265parse',
            requires: ['h265parse', 'avdec_h265'],
            hardware: false,
        },
    ],
};

/**
 * Every V4L2/stateless hardware rung on every ladder, deduplicated.
 *
 * The blast radius of the kernel's HEVC one-strike latch, in one place. The
 * latch is announced per-SoC, not per-codec — the driver disables the block and
 * the patch series that added it records a box that died outright when the
 * wedged hardware was poked again — so the video-player strikes off EVERY
 * hardware decoder on the box rather than only the one whose ladder the failing
 * stream happened to be on. Derived from the ladders so a rung added later is
 * covered without anyone remembering this list exists.
 *
 * NOTE the cost of that width: on a Pi 4 the H.264 hardware decoder is a
 * separate block (`bcm2835-codec`) from the HEVC one, so this gives up H.264
 * hardware decode on a fault it did not have. Narrowing the set is a one-line
 * change here if that trade ever stops being worth it.
 */
export const HARDWARE_DECODER_IDS: readonly string[] = [
    ...new Set(
        Object.values(DECODER_LADDERS)
            .flat()
            .filter((rung) => rung.hardware)
            .map((rung) => rung.id),
    ),
];

/**
 * `tsdemux` caps per codec, used for the pad-steering capsfilter — see
 * `DecoderSelection.caps`. Spelled out rather than derived from the codec name
 * so a future ladder entry can't silently produce a bogus media type.
 *
 * Exported so a test can assert it covers every key of `DECODER_LADDERS`: a
 * ladder entry without a caps entry is a build-time bug, and `selectDecoder`
 * refuses the explicit rungs rather than splice `caps="undefined"` into the
 * pipeline string.
 */
export const CODEC_CAPS: Readonly<Record<string, string>> = {
    h264: 'video/x-h264',
    h265: 'video/x-h265',
};

/**
 * Accepted `cpuDecodeThreading` values. The manifest offers `auto` and
 * `single`; `frame` is the pre-rename spelling of `auto`, still accepted so a
 * profile saved when multi-core was the opt-in keeps meaning multi-core.
 */
export const CPU_DECODE_THREADING = ['auto', 'frame', 'single'] as const;

/** `cpuDecodeThreading`, validated. See `resolveCpuDecodeThreading`. */
export type CpuDecodeThreading = (typeof CPU_DECODE_THREADING)[number];

/**
 * Normalise the raw `cpuDecodeThreading` config value. Anything unrecognised —
 * unset, junk, a value from a newer manifest — resolves to `'auto'`, the
 * default, so a bad config can never reach the pipeline string.
 */
export function resolveCpuDecodeThreading(value: unknown): CpuDecodeThreading {
    return CPU_DECODE_THREADING.includes(value as CpuDecodeThreading)
        ? (value as CpuDecodeThreading)
        : 'auto';
}

export interface DecoderSelectionInput {
    /** Codec from `tsprobe:videoinfo` (`h264` | `h265` | `mpeg2` | …). */
    codec?: string;
    /** Element availability, from `probeDecoderAvailability`. */
    available: DecoderAvailability;
    /** Decoders demoted by a runtime failure this engine session. */
    demoted?: ReadonlySet<string>;
    /**
     * `cpuDecodeThreading`, already validated by `resolveCpuDecodeThreading`.
     * The SETTING vocabulary, deliberately not the runner's `decoderThreadType`
     * ('auto' | 'frame'): the token `'auto'` means "threaded" here and "don't
     * force a thread-type" there, so mixing the two up would silently rebuild
     * the single-core pipeline this ladder exists to avoid.
     */
    threading?: CpuDecodeThreading;
}

export interface DecoderSelection {
    /** Rung id — decoder element name, or `decodebin3` for the final rung. */
    id: string;
    /** Pipeline fragment replacing the `decodebin3` element position. */
    chain: string;
    /**
     * Capsfilter fragment for the `tsdemux` output, or `''` on the decodebin3
     * rung. This sits DIRECTLY on tsdemux — see `buildLivePipeline` for why it
     * cannot sit after the leaky queue.
     */
    caps: string;
    /** True for a V4L2 hardware rung. */
    hardware: boolean;
    /** False on the decodebin3 rung: nothing below it to demote to. */
    explicit: boolean;
}

/** The final rung. Exported so callers can bootstrap without a codec. */
export const DECODEBIN_SELECTION: DecoderSelection = {
    id: DECODEBIN_ID,
    chain: DECODEBIN_ID,
    caps: '',
    hardware: false,
    explicit: false,
};

/**
 * `avdec_*` needs its threading set at element construction: GStreamer
 * single-threads live decode by default (gstavviddec.c demotes to
 * FF_THREAD_SLICE on a live latency query), and the runner's decoder-threads
 * hook deliberately leaves an element whose `max-threads` is already pinned
 * alone. Same inline form the transcoder uses, so the two paths can't drift.
 *
 * WHY THREADED IS THE DEFAULT. A bare `avdec_*` decodes on one core no matter
 * how idle the rest of the box is. Field case: a Pi 5 (no H.264 hardware
 * decoder) on a 1080p50 H.264 feed ran the explicit software rung
 * single-threaded, could not absorb arrival bursts and lagged the picture —
 * while the box sat 62% idle. `thread-type=frame max-threads=3` spreads that
 * decode over three cores for ~3 frames (~60 ms at 50 fps) of added latency,
 * which is the trade a software rung should take by default. `'single'` is the
 * way back to one core for a path where those 60 ms matter more.
 *
 * Hardware rungs are always bare: `thread-type`/`max-threads` are ffmpeg
 * properties, and a V4L2 decoder has neither.
 *
 * Every rung carries `name=vpdec` (see `VIDEO_DECODER_NAME`) — that is what
 * makes the decoder addressable from the runner for the keyframe gate.
 */
function decoderElement(rung: DecoderRung, threading: CpuDecodeThreading): string {
    const named = `${rung.id} name=${VIDEO_DECODER_NAME}`;
    if (rung.hardware || threading === 'single') return named;
    return `${named} thread-type=frame max-threads=3`;
}

/**
 * Pick the best usable decoder for a codec.
 *
 * Walks the codec's ladder top-down, skipping rungs whose elements aren't
 * installed and rungs demoted by a runtime failure, and returns `decodebin3`
 * when nothing is left (or the codec has no ladder / isn't known yet).
 */
export function selectDecoder(input: DecoderSelectionInput): DecoderSelection {
    const ladder = input.codec ? DECODER_LADDERS[input.codec] : undefined;
    if (!ladder) return DECODEBIN_SELECTION;

    // A ladder with no caps entry can't be built: every explicit rung needs the
    // pad-steering capsfilter (without it the leaky queue happily takes the
    // AUDIO pad — see buildLivePipeline), and an unguarded lookup would splice
    // the literal `caps="undefined"` into the pipeline string, which fails the
    // parse at runtime instead of at review. decodebin3 is the correct answer
    // for a codec we can't steer: it has always absorbed whatever pad it got.
    const caps = CODEC_CAPS[input.codec!];
    if (!caps) return DECODEBIN_SELECTION;

    const threading = input.threading ?? 'auto';
    const demoted = input.demoted;

    for (const rung of ladder) {
        if (demoted?.has(rung.id)) continue;
        if (!rung.requires.every((el) => input.available[el] === true)) continue;
        return {
            id: rung.id,
            chain: `${rung.parser} ! ${decoderElement(rung, threading)}`,
            caps: `capsfilter caps="${caps}"`,
            hardware: rung.hardware,
            explicit: true,
        };
    }
    return DECODEBIN_SELECTION;
}

/**
 * GStreamer's own rank override, read once at `Gst.init` in each runner child.
 * `<factory>:NONE` makes a plugin feature unselectable by auto-plugging.
 */
export const RANK_ENV_VAR = 'GST_PLUGIN_FEATURE_RANK';

/**
 * Per-pipeline rank override for the `decodebin3` rung — the DEMOTION ESCAPE,
 * and nothing else.
 *
 * The ladder's last rung is also `decodebin3`, so a codec whose every explicit
 * rung has been demoted lands on a bin that auto-plugs BY RANK — and rank
 * doesn't know about our demotions, so it plugs the very decoder that just
 * failed. That error is on the decodebin3 rung, where `classifyDecoderFailure`
 * returns `ignore` (nothing below it to demote to), so nothing breaks the loop:
 * fail → restart → replug the same broken decoder, forever. Masking the demoted
 * factories to NONE is what breaks it.
 *
 * NOTHING ELSE IS MASKED. With no demotions on the books the var is absent
 * entirely and `decodebin3` auto-plugs by rank, hardware included — on the
 * bootstrap build and on the last-rung fallback alike. Rank is what makes a box
 * with a hardware decoder use it without the pipeline string having to know
 * which box it is on, and a decoder that does prove itself broken is struck off
 * by demotion, which is exactly what this var then carries.
 *
 * ONLY on the decodebin3 rung. An explicit rung names its decoder outright, so
 * rank is irrelevant there; setting the var anyway would be a silent way to
 * lose a decoder we deliberately asked for — including the hardware one, which
 * is exactly the decoder the explicit rungs exist to use.
 *
 * Per-pipeline, not per-process: `PipelineDescription.env` is merged over
 * `process.env` at each runner spawn (see PythonProcess.start), and GStreamer
 * parses this var during `Gst.init` in that fresh child — so one player's mask
 * can't quietly change what another engine module auto-plugs.
 */
export function decoderRankEnv(
    selection: DecoderSelection,
    demoted: ReadonlySet<string> | undefined,
): Record<string, string> {
    if (selection.explicit) return {};
    // In the order the decoders failed — which reads as a history in the
    // process env of a degraded box. Nothing demoted → no var at all, rather
    // than an empty one GStreamer would still have to parse.
    const masked = [...(demoted ?? [])];
    if (masked.length === 0) return {};
    return { [RANK_ENV_VAR]: masked.map((id) => `${id}:NONE`).join(',') };
}

/**
 * Health text for a decoder the kernel switched off for the rest of the boot.
 *
 * Names HEVC rather than the demoted rung because HEVC is the block that
 * actually died — the `rpi-hevc-dec` latch is the only thing that ever sets a
 * permanent demotion (see `decoderDemotions.demotePermanently`). The rung the
 * pipeline landed on is appended by `decoderDemotionNote`.
 */
export const KERNEL_HW_DECODE_DISABLED_NOTE =
    'HEVC hardware decoder disabled by kernel until reboot — decoding in software';

/**
 * Operator-facing note for a codec whose better decoder(s) got demoted, or
 * `undefined` when nothing was demoted for this codec.
 *
 * Derived from state rather than from the failure event so the SAME text can
 * be set at the moment of failure and again on every rebuild afterwards —
 * otherwise the note would flash once and then be wiped by the rebuild's
 * `setHealth('ok')`. It names the BEST demoted rung, because that is the
 * capability the operator actually lost ("hardware decode is gone"); the log
 * line at the failure carries the precise per-rung detail.
 */
export function decoderDemotionNote(
    codec: string | undefined,
    selection: DecoderSelection,
    demoted: ReadonlySet<string>,
    permanent?: ReadonlySet<string>,
): string | undefined {
    const ladder = codec ? DECODER_LADDERS[codec] : undefined;
    const lost = ladder?.find((rung) => demoted.has(rung.id));
    if (!lost) return undefined;
    // A permanent demotion is only ever set by the kernel latch, and the
    // operator needs a different thing from this line then: not "it failed"
    // (which invites waiting for the retry) but "it is gone until you reboot".
    if (permanent?.has(lost.id)) return `${KERNEL_HW_DECODE_DISABLED_NOTE} (${selection.id})`;
    const using = selection.explicit
        ? selection.hardware
            ? `hardware decoder ${selection.id}`
            : `software decode (${selection.id})`
        : 'automatic decoder selection';
    return `${lost.hardware ? 'Hardware' : 'Software'} decoder ${lost.id} failed — using ${using}`;
}

/**
 * Probe every ladder element once. Injected probe function (the engine's
 * `probeGstElement`, which caches per process) keeps this testable and keeps
 * the I/O out of `selectDecoder`.
 */
export async function probeDecoderAvailability(
    probe: (element: string) => Promise<boolean>,
): Promise<DecoderAvailability> {
    const results = await Promise.all(DECODER_ELEMENTS.map((el) => probe(el)));
    const availability: Record<string, boolean> = {};
    DECODER_ELEMENTS.forEach((el, i) => {
        availability[el] = results[i];
    });
    return availability;
}

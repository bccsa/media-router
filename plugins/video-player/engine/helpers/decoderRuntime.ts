import { VIDEO_DECODER_NAME, type DecoderSelection } from './decoderSelection.js';

/**
 * The video player's runtime decoder state machine — the two decisions that
 * compare "what the stream is" against "what the running pipeline was built
 * for".
 *
 * `decoderSelection.ts` answers "which decoder for this codec"; this file
 * answers "given what is running, is a teardown worth it, and whose fault was
 * the error". Both are pure: the module owns the state (`detectedCodec`,
 * `liveDecoder`, `liveDecoderCodec`), the logging and the restart trigger.
 */

/** What a `tsprobe:videoinfo` codec report should cause. */
export type CodecReportAction =
    /** Nothing to compare against, or the pipeline already matches. */
    | { kind: 'ignore' }
    /** Same decoder rung — record the codec so repeat reports stay quiet. */
    | { kind: 'record-codec' }
    /** Different rung — tear down and build the new codec's chain. */
    | { kind: 'rebuild'; next: DecoderSelection };

export interface CodecReportInput {
    /** Codec just reported by the TS probe. */
    codec: string;
    /** Decoder rung the CURRENT live pipeline was built with; undefined while
     *  the fallback card is up. */
    liveDecoder?: DecoderSelection;
    /** Codec `liveDecoder` was chosen for — the debounce key for rebuilds. */
    liveDecoderCodec?: string;
    /** The module's `selectDecoderRung` (availability + demotions applied). */
    selectRung: (codec: string) => DecoderSelection;
}

/**
 * REBUILD, don't replug: decodebin3's in-place decoder switch is exactly what
 * wedged a live feed on software decode while still holding a hardware-decoder
 * handle, so a codec change always tears the pipeline down and builds the new
 * codec's chain from scratch.
 *
 * Debounced twice: no rebuild when the codec matches what the current pipeline
 * was built for, and no rebuild when the new codec resolves to the SAME rung
 * we're already running (an mpeg2 report while on decodebin3 changes nothing).
 */
export function planCodecReport(input: CodecReportInput): CodecReportAction {
    // Fallback card up (or no build recorded yet): nothing to compare
    // against. The remembered codec still steers the next live build.
    if (!input.liveDecoder) return { kind: 'ignore' };
    if (input.codec === input.liveDecoderCodec) return { kind: 'ignore' };
    const next = input.selectRung(input.codec);
    if (next.id === input.liveDecoder.id) return { kind: 'record-codec' };
    return { kind: 'rebuild', next };
}

/** What a pipeline error should cost the decoder that was running. */
export type DecoderFailureAction =
    /** Not the decoder's verdict — leave today's behaviour untouched. */
    | { kind: 'ignore' }
    /** Built for the wrong codec — rebuild without punishing the decoder. */
    | { kind: 'codec-changed' }
    /**
     * Not attributable to the decoder. The runner's `restartOnError` replays
     * the very same pipeline string, so the same decoder choice comes straight
     * back up — no demotion, no extra teardown.
     */
    | {
          kind: 'rebuild-same';
          /** Element the error came from, for the log line; absent = unattributed. */
          element?: string;
      }
    /** Strike this decoder off for the session and rebuild one rung down. */
    | { kind: 'demote'; failed: DecoderSelection };

/**
 * Error kinds SYNTHESISED by the runner layers rather than posted by the
 * GStreamer bus: the PLAYING watchdog in gst-pipeline-runner.py
 * (`playing_timeout`), and GstRunner/GstChildProcess's own child-lifecycle
 * failures (`spawn_failed`, `runner_exit`, `max_restarts`).
 *
 * None of them is evidence about the decoder — not because the failure was
 * unattributable, but because no element was involved at all. Named explicitly
 * rather than left to the element-less fallthrough so that a runner change
 * which starts forwarding some last-seen element name on one of these can
 * never turn a wedged compositor into a decoder demotion.
 */
export const SYNTHESISED_ERROR_KINDS: ReadonlySet<string> = new Set([
    'playing_timeout',
    'spawn_failed',
    'runner_exit',
    'max_restarts',
]);

export interface DecoderFailureInput {
    /** `kind` tag off the runner's error event. `udp_timeout` is ignored
     *  outright; the `SYNTHESISED_ERROR_KINDS` never demote. */
    errorKind?: string;
    /**
     * Source element INSTANCE name off the runner's error event — the gst bus
     * message's own `message.src` (e.g. `v4l2slh265dec0`, `h265parse0`,
     * `waylandsink0`). Optional: synthesised errors (child spawn failure, max
     * restarts, PLAYING watchdog) name no element.
     */
    element?: string;
    liveDecoder?: DecoderSelection;
    /** An internal restart cycle currently owns the pipeline. */
    restartInProgress: boolean;
    detectedCodec?: string;
    liveDecoderCodec?: string;
}

/**
 * Does this error's source element instance belong to the active decoder?
 *
 * TWO rules, because the explicit chain now NAMES its decoder:
 *  - the stable `vpdec` name every explicit rung gives the decoder, which is
 *    what the bus reports as the error source on such a pipeline (see
 *    `VIDEO_DECODER_NAME` — it exists so the runner's keyframe gate can find
 *    the pad), and
 *  - a factory-name prefix match, for anything gst named itself
 *    (`v4l2slh265dec` → `v4l2slh265dec0`) — still the rule for a decoder
 *    plugged inside `decodebin3`, and the safety net if the name is ever
 *    dropped from the chain.
 *
 * Parsers (`h265parse0`), sinks, queues, the tee, the demux and the bus source
 * fail both — which is the whole point: only the decoder's own errors may cost
 * it its rung.
 */
function isDecoderElement(element: string, decoderId: string): boolean {
    return element === VIDEO_DECODER_NAME || element.startsWith(decoderId);
}

/**
 * Runtime demotion. A live pipeline built with an EXPLICIT decoder that the
 * DECODER ITSELF fails gets that decoder struck off for the rest of the engine
 * session and is rebuilt one rung down — hardware → software → decodebin3.
 * Observed for real on this hardware: `v4l2slh265dec` posts "Driver does
 * not support the selected stream" on a profile the rpivid block can't
 * take, which no amount of probing at init could have predicted.
 *
 * ATTRIBUTION IS LOAD-BEARING, and it is a SINGLE rule: only an error the bus
 * blames on the active explicit decoder's own element may cost it its rung.
 * The decision table, in order:
 *
 *   udp_timeout / no explicit decoder / internal restart  → ignore
 *   codec changed since the build                         → codec-changed
 *   runner-synthesised kind (no element was involved)     → rebuild-same
 *   error names the active decoder's element              → demote
 *   error names ANY other element                         → rebuild-same
 *   error names nothing at all                            → rebuild-same
 *
 * WHY NOTHING ELSE DEMOTES. An error that doesn't name the decoder is not
 * evidence about the decoder, however many times it repeats. A count-based
 * escape hatch for the element-less case was tried and removed: it demoted on
 * pattern rather than proof, so a compositor flap or a bus rewire mid
 * engine-restart could still strand a verifiably healthy hardware decoder on
 * software decode for the rest of the session, and only an engine restart
 * cleared it. If the decoder really is broken it says so — that is the whole
 * point of the runner naming the source element on every bus error (see
 * busRunnerContract.test.ts).
 *
 * Errors on the decodebin3 rung (and on the fallback card) keep today's
 * behaviour untouched: the base class has already flagged health=error and
 * the runner's restartOnError replays the same pipeline. So does `rebuild-same`
 * — it is the "let the replay happen, just don't punish the decoder" verdict.
 */
export function classifyDecoderFailure(input: DecoderFailureInput): DecoderFailureAction {
    // Source-side timeout, not a decode failure.
    if (input.errorKind === 'udp_timeout') return { kind: 'ignore' };

    const failed = input.liveDecoder;
    if (!failed?.explicit) return { kind: 'ignore' };

    // An internal restart already owns the pipeline — a renderwatch
    // self-heal, a cog restack, a stall/resume rebuild. Errors thrown by a
    // pipeline being torn down are not the decoder's verdict, and the latch
    // is held for the whole onStop+onStart window, so this covers it.
    if (input.restartInProgress) return { kind: 'ignore' };

    // The probe reported a DIFFERENT codec after this pipeline was
    // built: the chain failed because it was steering the wrong
    // codec's caps, not because the decoder is broken. Rebuild for the
    // new codec without punishing a decoder that never got the stream
    // it was meant for. (The codec-change rebuild may already be in
    // flight; restartPipeline coalesces.)
    if (input.detectedCodec !== input.liveDecoderCodec) return { kind: 'codec-changed' };

    // Runner-synthesised lifecycle failure — nothing in the pipeline posted it,
    // so it is not evidence about the decoder either way. Rebuild; the runner's
    // replay does that anyway.
    if (input.errorKind && SYNTHESISED_ERROR_KINDS.has(input.errorKind)) {
        return { kind: 'rebuild-same' };
    }

    // The one rule that costs a decoder its rung.
    const element = input.element;
    if (element && isDecoderElement(element, failed.id)) return { kind: 'demote', failed };

    // A parser, sink, queue, demux or bus source failed — or nothing named
    // itself at all. Either way it is not the decoder's verdict: replay the
    // same pipeline and let it keep its rung.
    return element ? { kind: 'rebuild-same', element } : { kind: 'rebuild-same' };
}

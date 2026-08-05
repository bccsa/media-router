import { DECODER_LADDERS, type DecoderSelection } from './decoderSelection.js';

/**
 * Demotion bookkeeping with an AGE-OUT.
 *
 * `decoderSelection.ts` takes the demotion set as data; this file owns the set
 * and the one thing that set needs beyond membership — WHEN each decoder was
 * struck off, so a demotion can expire.
 *
 * WHY AGE OUT AT ALL. A demotion used to last the whole engine session. One
 * corrupt slice in a live feed was enough to strike the hardware decoder off,
 * and the box then burned 80%+ CPU on software decode for hours until someone
 * restarted the engine — for a stream that was healthy again seconds later. A
 * hardware failure is now cheap to take (the driver abandons a wedged decode in
 * ~2 s and resets the block instead of hanging V4L2 box-wide), so periodically
 * putting hardware back on trial is the better trade: worst case one glitch per
 * TTL, best case the box climbs back off software decode on its own.
 *
 * The retry cadence IS the TTL — a decoder that fails again is simply re-demoted
 * with a fresh timestamp, so a permanently broken decoder costs one failed
 * rebuild every TTL and nothing else.
 */

/** Override for `DEFAULT_DEMOTION_TTL_MS`, read per call (see `resolveDemotionTtlMs`). */
export const DEMOTION_TTL_ENV_VAR = 'VP_DECODER_DEMOTION_TTL_MS';

/**
 * How long a demotion steers decoder selection. 5 minutes: long enough that a
 * decoder failing on every keyframe can't turn the pipeline into a rebuild
 * loop, short enough that a transient stream fault costs minutes of software
 * decode rather than the rest of the session.
 */
export const DEFAULT_DEMOTION_TTL_MS = 300_000;

/**
 * TTL in force, from the environment. Junk, empty and negative values fall back
 * to the default rather than disabling the age-out by accident.
 *
 * `0` is the deliberate opt-OUT: demotions last the whole engine session again,
 * for a box whose hardware decoder is known-broken and where the retry's one
 * glitch per TTL is not worth paying.
 */
export function resolveDemotionTtlMs(
    raw: string | undefined = process.env[DEMOTION_TTL_ENV_VAR],
): number {
    if (raw === undefined || raw.trim() === '') return DEFAULT_DEMOTION_TTL_MS;
    const ms = Number(raw);
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DEMOTION_TTL_MS;
}

/**
 * Decoders struck off by a runtime failure, each with the moment it happened.
 *
 * Insertion-ordered like the `Set` it replaces: `decoderRankEnv` renders the
 * mask in failure order, which reads as a history in a degraded box's env.
 *
 * `now` is passed in on every call — the module supplies `Date.now()`, the same
 * clock `setTimeout` counts against, so the retry timer and this expiry test can
 * never disagree about whether a demotion is still in force.
 */
export class DecoderDemotions {
    private readonly demotedAt = new Map<string, number>();

    /** Strike a decoder off, or re-strike one that failed its retry. */
    demote(id: string, now: number): void {
        // delete first: a re-demotion should move to the back of the failure
        // order as well as get a fresh timestamp.
        this.demotedAt.delete(id);
        this.demotedAt.set(id, now);
    }

    /** Demotions still in force at `now` — the set every plan is computed against. */
    active(now: number, ttlMs: number = resolveDemotionTtlMs()): ReadonlySet<string> {
        const live = new Set<string>();
        for (const [id, at] of this.demotedAt) {
            if (!isExpired(at, now, ttlMs)) live.add(id);
        }
        return live;
    }

    /**
     * Drop the demotions that have aged out and return them, oldest first.
     *
     * Housekeeping plus the log line — `active` already filters by age, so
     * nothing depends on this having run.
     */
    prune(now: number, ttlMs: number = resolveDemotionTtlMs()): string[] {
        const expired: string[] = [];
        for (const [id, at] of this.demotedAt) {
            if (isExpired(at, now, ttlMs)) expired.push(id);
        }
        expired.forEach((id) => this.demotedAt.delete(id));
        return expired;
    }

    /**
     * When the first demotion that outranks `current` ages out, or `undefined`
     * when there is nothing better to go back to (nothing demoted above the
     * running rung, no ladder for this codec, or the age-out is disabled).
     *
     * "Outranks" is ladder position: rungs above the running one. A rung that
     * isn't on the ladder at all — `decodebin3`, or a codec change that hasn't
     * rebuilt yet — sits below every rung, so every demotion on that ladder
     * counts.
     */
    retryAt(
        codec: string | undefined,
        current: DecoderSelection,
        ttlMs: number = resolveDemotionTtlMs(),
    ): number | undefined {
        if (ttlMs <= 0) return undefined;
        const ladder = codec ? DECODER_LADDERS[codec] : undefined;
        if (!ladder) return undefined;
        const running = ladder.findIndex((rung) => rung.id === current.id);
        const better = running === -1 ? ladder : ladder.slice(0, running);
        let earliest: number | undefined;
        for (const rung of better) {
            const at = this.demotedAt.get(rung.id);
            if (at === undefined) continue;
            const expiry = at + ttlMs;
            if (earliest === undefined || expiry < earliest) earliest = expiry;
        }
        return earliest;
    }

    clear(): void {
        this.demotedAt.clear();
    }
}

function isExpired(demotedAt: number, now: number, ttlMs: number): boolean {
    // ttlMs <= 0 disables the age-out entirely — see resolveDemotionTtlMs.
    // `>=` so a timer armed for exactly the deadline finds the demotion gone
    // rather than one tick short of it.
    return ttlMs > 0 && now - demotedAt >= ttlMs;
}

import { describe, it, expect } from 'vitest';
import {
    backlogShedConfig,
    BACKLOG_SHED_COOLDOWN_MS,
    BACKLOG_SHED_EVENT,
    BACKLOG_SHED_HOLD_MS,
    BACKLOG_SHED_SANITY_MS,
    BACKLOG_SHED_TOLERANCE_MS,
} from './backlogShed.js';
import { MAX_PLAYOUT_OFFSET_MS } from './playoutOffset.js';

const VIDEO = { element: 'vpdec', sink: 'sink', keyframeAligned: true };

describe('backlogShedConfig — the contract gate', () => {
    it('is armed under the time-sync contract', () => {
        const cfg = backlogShedConfig({ timeSyncContract: true }, VIDEO);
        expect(cfg).toEqual({
            element: 'vpdec',
            sink: 'sink',
            keyframeAligned: true,
            toleranceMs: BACKLOG_SHED_TOLERANCE_MS,
            holdMs: BACKLOG_SHED_HOLD_MS,
            cooldownMs: BACKLOG_SHED_COOLDOWN_MS,
            sanityMs: BACKLOG_SHED_SANITY_MS,
        });
    });

    // The whole legacy story: with the contract off nothing is sent, so the
    // runner arms nothing and a `sync=false` leg — which drains its own backlog
    // and has no ratchet — behaves exactly as it always did.
    it('is NOT armed with the contract off, absent, or services missing', () => {
        expect(backlogShedConfig({ timeSyncContract: false }, VIDEO)).toBeUndefined();
        expect(backlogShedConfig({}, VIDEO)).toBeUndefined();
        expect(backlogShedConfig(null, VIDEO)).toBeUndefined();
        expect(backlogShedConfig(undefined, VIDEO)).toBeUndefined();
    });

    it('only a literal true arms it — a truthy value is not a contract', () => {
        expect(
            backlogShedConfig({ timeSyncContract: 1 as unknown as boolean }, VIDEO),
        ).toBeUndefined();
    });

    it('carries the leg-specific names through untouched', () => {
        const audio = backlogShedConfig(
            { timeSyncContract: true },
            { element: 'sink', sink: 'sink', keyframeAligned: false },
        );
        expect(audio?.element).toBe('sink');
        expect(audio?.keyframeAligned).toBe(false);
    });

    // Both legs of a route resolve their numbers from THIS module, which is the
    // property that makes "one contract, one policy" true by construction rather
    // than by two implementations agreeing (the same reason D lives in
    // playoutOffset.ts).
    it('gives every leg the same policy numbers', () => {
        const video = backlogShedConfig({ timeSyncContract: true }, VIDEO);
        const audio = backlogShedConfig(
            { timeSyncContract: true },
            { element: 'sink', sink: 'sink', keyframeAligned: false },
        );
        expect({ ...video, element: '', keyframeAligned: false }).toEqual({
            ...audio,
            element: '',
            keyframeAligned: false,
        });
    });
});

describe('the policy numbers themselves', () => {
    it('tolerates less than the ES queue holds — a shed must beat the queue caps', () => {
        // The video leg's ES queue is floored at 1 s and the sink drops nearly
        // everything past `max-lateness=1 s`. A tolerance at or above either
        // would let the leg reach the cliff before the guard ever fired.
        expect(BACKLOG_SHED_TOLERANCE_MS).toBeLessThan(1_000);
        // …and more than one absorbed IDR burst (~200 ms of stream time), or
        // the guard would shed on the burst absorption the queue exists for.
        expect(BACKLOG_SHED_TOLERANCE_MS).toBeGreaterThan(200);
    });

    it('holds long enough that a transient cannot trip it', () => {
        expect(BACKLOG_SHED_HOLD_MS).toBeGreaterThanOrEqual(5_000);
    });

    it('cooldown is far longer than the hold — oscillation is impossible', () => {
        expect(BACKLOG_SHED_COOLDOWN_MS).toBeGreaterThan(5 * BACKLOG_SHED_HOLD_MS);
    });

    it('refuses to act on anything a real playout budget could not explain', () => {
        // Same ceiling as the largest configurable D: past it the reading is a
        // timeline mismatch, and shedding to a target on a timeline the leg is
        // not on would drop the entire stream.
        expect(BACKLOG_SHED_SANITY_MS).toBe(MAX_PLAYOUT_OFFSET_MS);
    });

    it('the event channel is the literal both processes use', () => {
        expect(BACKLOG_SHED_EVENT).toBe('backlog_shed');
    });
});

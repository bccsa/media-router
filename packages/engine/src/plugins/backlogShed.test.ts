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
import {
    REANCHOR_HOLD_MS,
    REANCHOR_RETRY_MS,
    REANCHOR_TOLERANCE_MS,
    REBASE_COOLDOWN_MS,
    REBASE_HOLD_MS,
} from './playoutReanchor.js';

const VIDEO = { element: 'vpdec', sink: 'sink', keyframeAligned: true };

describe('backlogShedConfig', () => {
    it('is armed on every clock-paced leg, services or not', () => {
        const want = {
            element: 'vpdec',
            sink: 'sink',
            keyframeAligned: true,
            toleranceMs: BACKLOG_SHED_TOLERANCE_MS,
            holdMs: BACKLOG_SHED_HOLD_MS,
            cooldownMs: BACKLOG_SHED_COOLDOWN_MS,
            sanityMs: BACKLOG_SHED_SANITY_MS,
        };
        expect(backlogShedConfig({}, VIDEO)).toEqual(want);
        expect(backlogShedConfig(null, VIDEO)).toEqual(want);
        expect(backlogShedConfig(undefined, VIDEO)).toEqual(want);
    });

    it('carries the leg-specific names through untouched', () => {
        const audio = backlogShedConfig(
            {},
            { element: 'sink', sink: 'sink', keyframeAligned: false },
        );
        expect(audio.element).toBe('sink');
        expect(audio.keyframeAligned).toBe(false);
    });

    // Both legs of a route resolve their numbers from THIS module, which is the
    // property that makes "one contract, one policy" true by construction rather
    // than by two implementations agreeing (the same reason D lives in
    // playoutOffset.ts).
    it('gives every leg the same policy numbers', () => {
        const video = backlogShedConfig({}, VIDEO);
        const audio = backlogShedConfig(
            {},
            { element: 'sink', sink: 'sink', keyframeAligned: false },
        );
        expect({ ...video, element: '', keyframeAligned: false }).toEqual({
            ...audio,
            element: '',
            keyframeAligned: false,
        });
    });
});

// Never drop on lateness (ADR-0005 amendment 2026-10-08): with the re-anchor
// switch on, the SAME config asks the runner to raise instead of shed, and
// carries the numbers from playoutReanchor.ts. Off (MR_PLAYOUT_REANCHOR=0), the
// config is byte-identical to the shed-only one — both runners shed as before.
describe('backlogShedConfig — re-anchor mode', () => {
    it('carries onLateness and the five re-anchor numbers when on', () => {
        expect(backlogShedConfig({ playoutReanchor: true }, VIDEO)).toEqual({
            element: 'vpdec',
            sink: 'sink',
            keyframeAligned: true,
            toleranceMs: BACKLOG_SHED_TOLERANCE_MS,
            holdMs: BACKLOG_SHED_HOLD_MS,
            cooldownMs: BACKLOG_SHED_COOLDOWN_MS,
            sanityMs: BACKLOG_SHED_SANITY_MS,
            onLateness: 'reanchor',
            reanchorToleranceMs: REANCHOR_TOLERANCE_MS,
            reanchorHoldMs: REANCHOR_HOLD_MS,
            reanchorRetryMs: REANCHOR_RETRY_MS,
            rebaseHoldMs: REBASE_HOLD_MS,
            rebaseCooldownMs: REBASE_COOLDOWN_MS,
        });
    });

    it('off, or not literally true, the config has none of the keys', () => {
        for (const flag of [false, undefined, 1 as unknown as boolean]) {
            const cfg = backlogShedConfig({ playoutReanchor: flag }, VIDEO);
            expect(cfg).toEqual(backlogShedConfig({}, VIDEO));
            expect(cfg).not.toHaveProperty('onLateness');
        }
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

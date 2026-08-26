import { describe, it, expect } from 'vitest';
import { DuckLiveThrottle, type DuckLive, type DuckPhase } from './duckLive.js';

function collect() {
    const published: Array<DuckLive | null> = [];
    const throttle = new DuckLiveThrottle((live) => published.push(live));
    return { published, throttle };
}

/** One envelope reading — gain is what the throttle actually reasons about. */
const at = (gainDb: number, keyDb: number | null = -8, phase: DuckPhase = 'attack'): DuckLive => ({
    gainDb,
    keyDb,
    phase,
});

describe('DuckLiveThrottle', () => {
    it('publishes the onset of a duck immediately', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-3), 1_000);
        expect(published).toEqual([{ gainDb: -3, keyDb: -8, phase: 'attack' }]);
    });

    it('says nothing at all while the ducker sits at unity', () => {
        const { published, throttle } = collect();
        for (let t = 0; t < 20; t++) throttle.offer(at(0, -50, 'idle'), 1_000 + t * 15);
        expect(published).toEqual([]);
    });

    it('holds at 4 Hz however fast the envelope ticks', () => {
        const { published, throttle } = collect();
        // 15 Hz of readings walking steadily down to a -12 dB floor.
        let db = 0;
        for (let i = 0; i < 60; i++) {
            db = Math.max(-12, db - 0.4);
            throttle.offer(at(db), 1_000 + i * 15);
        }
        // 900 ms of ticks: the onset plus one per 250 ms window, never 60.
        expect(published.length).toBeLessThanOrEqual(1 + Math.ceil(900 / 250));
        expect(published.length).toBeGreaterThan(1);
    });

    it('ignores a move smaller than 0.5 dB even when the rate allows one', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-6), 1_000);
        throttle.offer(at(-6.4), 5_000); // 0.4 dB — not worth a broadcast
        expect(published).toHaveLength(1);
        throttle.offer(at(-6.6), 9_000); // 0.6 dB — published
        expect(published).toHaveLength(2);
        expect(published[1]).toMatchObject({ gainDb: -6.6 });
    });

    it('publishes one settle back to unity, then goes quiet', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-12, -8, 'hold'), 1_000);
        // Back at unity: a single null clears the live overlay rather than
        // leaving a dot parked at the last key level it saw.
        throttle.offer(at(0, -50, 'idle'), 1_300);
        expect(published).toEqual([{ gainDb: -12, keyDb: -8, phase: 'hold' }, null]);
        for (let i = 0; i < 20; i++) throttle.offer(at(0, -50, 'idle'), 2_000 + i * 15);
        expect(published).toHaveLength(2);
    });

    it('settles even when the last step is smaller than the delta', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-12), 1_000);
        throttle.offer(at(-0.4, -50, 'release'), 1_300); // released to a whisker of unity
        throttle.offer(at(0, -50, 'idle'), 1_600); // the last 0.4 dB — settle beats the delta
        expect(published).toHaveLength(3);
        expect(published.at(-1)).toBeNull();
    });

    it('retries a settle dropped by the rate limit on the next tick', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-12), 1_000);
        throttle.offer(at(0, -50, 'idle'), 1_100); // too soon — dropped
        expect(published).toHaveLength(1);
        throttle.offer(at(0, -50, 'idle'), 1_260);
        expect(published.at(-1)).toBeNull();
        expect(published).toHaveLength(2);
    });

    it('carries the phase through, so the dot can be placed', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-4, -8, 'attack'), 1_000);
        throttle.offer(at(-12, -6, 'hold'), 2_000);
        throttle.offer(at(-5, -50, 'release'), 3_000);
        expect(published.map((p) => p?.phase)).toEqual(['attack', 'hold', 'release']);
    });

    it('rounds to a tenth of a dB and tolerates a reading with no key level', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-6.4321, null), 1_000);
        expect(published[0]).toEqual({ gainDb: -6.4, keyDb: null, phase: 'attack' });
    });

    it('publishes a copy, so a mutating envelope cannot rewrite history', () => {
        const { published, throttle } = collect();
        const live = at(-6);
        throttle.offer(live, 1_000);
        live.gainDb = -11; // the envelope ticks on
        expect(published[0]).toMatchObject({ gainDb: -6 });
    });

    it('forgets the run on reset, so the next duck publishes its onset', () => {
        const { published, throttle } = collect();
        throttle.offer(at(-12), 1_000);
        throttle.reset();
        throttle.offer(at(-12), 1_050); // inside the rate window, but a new run
        expect(published).toHaveLength(2);
        expect(published[1]).toMatchObject({ gainDb: -12 });
    });
});

import { describe, it, expect } from 'vitest';
import { DuckLiveThrottle, readDuckerMessage, type DuckLive, type DuckPhase } from './duckLive.js';

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

describe('readDuckerMessage', () => {
    /** An `mrducker` message as both runners forward it (`gst_structure_to_json`). */
    const msg = (o: Record<string, unknown> = {}) => ({
        'running-time': 1_234_000_000,
        'gain-db': -7.25,
        'key-db': -18.5,
        phase: 'attack',
        ...o,
    });

    it('reads gain, key and phase', () => {
        expect(readDuckerMessage(msg())).toEqual({ gainDb: -7.25, keyDb: -18.5, phase: 'attack' });
        for (const phase of ['idle', 'attack', 'hold', 'release']) {
            expect(readDuckerMessage(msg({ phase }))?.phase).toBe(phase);
        }
    });

    it('a key level the runner could not encode (null) is no key level, not 0 dB', () => {
        expect(readDuckerMessage(msg({ 'key-db': null }))).toEqual({
            gainDb: -7.25,
            keyDb: null,
            phase: 'attack',
        });
        expect(readDuckerMessage(msg({ 'key-db': 'x' }))?.keyDb).toBeNull();
    });

    it('anything else is no reading', () => {
        // The native runner sends a non-finite double as null: Number(null) would read unity.
        expect(readDuckerMessage(msg({ 'gain-db': null }))).toBeNull();
        expect(readDuckerMessage(msg({ 'gain-db': '-6' }))).toBeNull();
        expect(readDuckerMessage(msg({ 'gain-db': Infinity }))).toBeNull();
        expect(readDuckerMessage(msg({ phase: 'ducking' }))).toBeNull();
        expect(readDuckerMessage(msg({ phase: undefined }))).toBeNull();
        expect(readDuckerMessage(undefined)).toBeNull();
        expect(readDuckerMessage('mrducker')).toBeNull();
    });
});

describe('DuckLiveThrottle on mrducker readings (10 Hz of content)', () => {
    it('a duck and its release at 10 Hz publish at most 4 Hz, then settle once', () => {
        const { published, throttle } = collect();
        const at: number[] = [];
        const offer = (t: number, payload: Record<string, unknown>) => {
            const n = published.length;
            throttle.offer(readDuckerMessage(payload)!, t);
            if (published.length > n) at.push(t);
        };
        // 1 s ducking to a -24 dB floor, 1 s hold, then a 1 s release to unity.
        let t = 10_000;
        for (let i = 1; i <= 10; i++) {
            offer((t += 100), { 'gain-db': -2.4 * i, 'key-db': -10, phase: 'attack' });
        }
        for (let i = 0; i < 10; i++) {
            offer((t += 100), { 'gain-db': -24, 'key-db': -10, phase: 'hold' });
        }
        for (let i = 9; i >= 0; i--) {
            offer((t += 100), {
                'gain-db': -2.4 * i,
                'key-db': -120,
                phase: i ? 'release' : 'idle',
            });
        }
        for (let i = 0; i < 10; i++)
            offer((t += 100), { 'gain-db': 0, 'key-db': -120, phase: 'idle' });
        for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(250);
        expect(published[0]).toEqual({ gainDb: -2.4, keyDb: -10, phase: 'attack' });
        // 40 readings: the onset, ≤ 4 per second while moving, and one null at unity.
        expect(published.length).toBeGreaterThan(4);
        expect(published.length).toBeLessThanOrEqual(1 + 3 * 4);
        expect(published.at(-1)).toBeNull();
        expect(published.filter((p) => p === null)).toHaveLength(1);
    });
});

import { describe, it, expect } from 'vitest';
import { DuckerEnvelope } from './duckerEnvelope.js';

/** Drive the envelope with `ticks` readings at `keyDb`, `stepMs` apart. */
function run(
    config: Record<string, unknown>,
    keyDb: number,
    ticks: number,
    stepMs = 15,
    envelope = new DuckerEnvelope(),
) {
    let t = 1_000_000;
    envelope.reset(t);
    const writes: number[] = [];
    for (let i = 0; i < ticks; i++) {
        t += stepMs;
        const gain = envelope.advance([keyDb, keyDb - 3], config, t);
        if (gain !== null) writes.push(gain);
    }
    return { envelope, writes, lastGain: writes.length ? writes[writes.length - 1] : 1 };
}

describe('DuckerEnvelope', () => {
    it('ducks the program to the exact floor while the key is over threshold', () => {
        const { lastGain } = run({ threshold: -35, duckDepth: -12, attack: 5 }, -3, 40);
        expect(lastGain).toBeCloseTo(10 ** (-12 / 20), 2); // 0.251
    });

    it('stays at unity below threshold (no IPC at all)', () => {
        const { writes } = run({ threshold: -35 }, -50, 20);
        expect(writes).toHaveLength(0);
    });

    it('holds the duck after the key drops, then releases back to unity', () => {
        const env = new DuckerEnvelope();
        const config = { threshold: -35, duckDepth: -12, attack: 5, release: 200, hold: 250 };
        run(config, -3, 40, 15, env); // fully ducked
        expect(env.gainDb).toBeCloseTo(-12, 5);

        // Inside the hold window the floor is kept even though the key is gone.
        let t = 1_000_600;
        env.advance([-60], config, (t += 15));
        expect(env.gainDb).toBeCloseTo(-12, 5);

        // Past the hold, the release ramp walks back to unity.
        for (let i = 0; i < 60; i++) env.advance([-60], config, (t += 15));
        expect(env.gainDb).toBe(0);
    });

    it('keys off the LOUDEST channel, not the first', () => {
        const env = new DuckerEnvelope();
        env.reset(0);
        // rms[1] is over threshold, rms[0] is not.
        expect(env.advance([-60, -3], { threshold: -35, duckDepth: -12 }, 15)).not.toBeNull();
        expect(env.gainDb).toBeLessThan(0);
    });

    it('ignores an empty reading', () => {
        const env = new DuckerEnvelope();
        env.reset(0);
        expect(env.advance([], { threshold: -35 }, 15)).toBeNull();
    });

    it('a late reading cannot slam the gain — one step is capped at 100 ms', () => {
        const env = new DuckerEnvelope();
        env.reset(0);
        // attack 500 ms over a -60 dB floor = 0.12 dB/ms. A 10 s gap (stalled
        // key branch, blocked event loop) integrates 100 ms, not 10 000.
        env.advance([0], { threshold: -35, duckDepth: -60, attack: 500 }, 10_000);
        expect(env.gainDb).toBeCloseTo(-12, 5);
    });

    it('re-seeds to unity on reset (sticky replay may hold a duck)', () => {
        const { envelope } = run({ threshold: -35, duckDepth: -12 }, -3, 40);
        expect(envelope.gainDb).toBeLessThan(0);
        envelope.reset(2_000_000);
        expect(envelope.gainDb).toBe(0);
        // …and the next over-threshold reading ducks again from unity.
        const gain = envelope.advance([-3], { threshold: -35, duckDepth: -12 }, 2_000_015);
        expect(gain).not.toBeNull();
        expect(gain!).toBeLessThan(1);
    });

    it('only reports a gain when it has actually moved', () => {
        const env = new DuckerEnvelope();
        const config = { threshold: -35, duckDepth: -12, attack: 5 };
        env.reset(0);
        let t = 0;
        for (let i = 0; i < 40; i++) env.advance([-3], config, (t += 15));
        // Pinned at the floor: further readings are free.
        expect(env.advance([-3], config, (t += 15))).toBeNull();
    });

    it('names the leg it is on, so the graph can place a live dot', () => {
        // Slow attack, so a single reading lands mid-ramp instead of at the floor.
        const config = { threshold: -35, duckDepth: -12, attack: 300, release: 300, hold: 250 };
        const env = new DuckerEnvelope();
        env.reset(0);
        expect(env.phase).toBe('idle');

        let t = 0;
        env.advance([-60], config, (t += 15)); // key below threshold
        expect(env.phase).toBe('idle');

        env.advance([-3], config, (t += 15)); // key opens: walking down
        expect(env.phase).toBe('attack');
        expect(env.gainDb).toBeGreaterThan(-12);

        for (let i = 0; i < 40; i++) env.advance([-3], config, (t += 15));
        expect(env.gainDb).toBeCloseTo(-12, 5);
        expect(env.phase).toBe('hold'); // pinned at the floor, key still up

        env.advance([-60], config, (t += 15)); // key drops — inside the hold window
        expect(env.phase).toBe('hold');

        for (let i = 0; i < 20; i++) env.advance([-60], config, (t += 15)); // past hold
        expect(env.phase).toBe('release');
        expect(env.gainDb).toBeGreaterThan(-12);

        for (let i = 0; i < 40; i++) env.advance([-60], config, (t += 15));
        expect(env.gainDb).toBe(0);
        expect(env.phase).toBe('idle');
    });

    it('reads its parameters live, so a slider move needs no restart', () => {
        const env = new DuckerEnvelope();
        env.reset(0);
        let t = 0;
        for (let i = 0; i < 40; i++)
            env.advance([-3], { threshold: -35, duckDepth: -12, attack: 5 }, (t += 15));
        expect(env.gainDb).toBeCloseTo(-12, 5);
        // Deeper floor mid-flight — the envelope walks on to the new target.
        for (let i = 0; i < 40; i++)
            env.advance([-3], { threshold: -35, duckDepth: -24, attack: 5 }, (t += 15));
        expect(env.gainDb).toBeCloseTo(-24, 5);
    });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExponentialBackoff } from './ExponentialBackoff.js';

describe('ExponentialBackoff stability window', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Pin jitter to exactly 1.0 so delays are deterministic
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('markStable resets attempts after stabilityMs of no failures', () => {
        const b = new ExponentialBackoff(3000, 30000, 0, 60000);
        b.nextDelay(); // attempt 1
        b.nextDelay(); // attempt 2
        expect(b.attempts).toBe(2);

        b.markStable();
        vi.advanceTimersByTime(60_100);

        expect(b.attempts).toBe(0);
        expect(b.nextDelay()).toBe(3000); // back at base
        b.destroy();
    });

    it('a failure interrupts a pending stability window', () => {
        // Regression: connect → markStable → disconnect 10s later. The
        // stability timer must NOT fire 60s after the connect and zero the
        // attempt counter mid-retry-loop — that made a flapping link reset
        // its backoff every cycle.
        const b = new ExponentialBackoff(3000, 30000, 0, 60000);
        b.nextDelay(); // attempt 1
        b.markStable(); // "connected"

        vi.advanceTimersByTime(10_000);
        expect(b.nextDelay()).toBe(6000); // "disconnected" — attempt 2, escalated

        // The original 60s stability timer must be dead now
        vi.advanceTimersByTime(60_000);
        expect(b.attempts).toBe(2);
        expect(b.nextDelay()).toBe(12_000); // attempt 3 — still escalating
        b.destroy();
    });
});

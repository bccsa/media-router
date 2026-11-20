import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    LIVENESS_PERIOD_MS,
    LIVENESS_TIMEOUT_MS,
    RunnerLiveness,
    notAnsweringText,
} from './runnerLiveness.js';

// B-246: the ask cadence and the two-miss rule, on fake timers.
/** A re-ask "at once" is a 0 ms timer, which node runs 1 ms later. */
const S = 10;
afterEach(() => vi.useRealTimers());

/** An ask that answers while `alive`; a frozen one answers at the resume, or times out first. */
function rig() {
    vi.useFakeTimers();
    const state = { alive: true, asked: 0, notAsked: false };
    const held: Array<(v: boolean) => void> = [];
    const resume = () => {
        state.alive = true;
        held.splice(0).forEach((r) => r(true));
    };
    const stalled = vi.fn();
    const answered = vi.fn();
    const w = new RunnerLiveness({
        ask: (timeoutMs) => {
            state.asked++;
            if (state.notAsked) return Promise.resolve(null);
            if (state.alive) return Promise.resolve(true);
            return new Promise((r) => {
                held.push(r);
                setTimeout(() => r(false), timeoutMs);
            });
        },
        stalled,
        answered,
    });
    return { w, state, stalled, answered, resume };
}

describe('RunnerLiveness (B-246)', () => {
    it('asks every 5 s while it answers, and says nothing', async () => {
        const { w, state, stalled } = rig();
        w.start();
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS * 4);
        expect(state.asked).toBe(4);
        expect(stalled).not.toHaveBeenCalled();
        w.stop();
    });

    it('two misses in a row warn: 6 s after the first unanswered ask, 6-11 s after the freeze', async () => {
        const { w, state, stalled } = rig();
        w.start();
        // Freeze just after the 5 s answer: the worst case.
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + 1);
        state.alive = false;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS - 1 + LIVENESS_TIMEOUT_MS);
        expect(stalled).not.toHaveBeenCalled(); // one miss
        await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS - S);
        expect(stalled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2 * S);
        expect(stalled).toHaveBeenCalledTimes(1);
        expect(stalled).toHaveBeenLastCalledWith(notAnsweringText(11), 11);
        // Each further miss updates the count (asks every 3 s while it stays silent).
        await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS);
        expect(stalled).toHaveBeenLastCalledWith(
            'Pipeline not answering for 14 s (stalled or frozen)',
            14,
        );
        w.stop();
    });

    it('the next answer withdraws it, within one ask of the resume', async () => {
        const { w, state, stalled, answered, resume } = rig();
        w.start();
        state.alive = false;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + 2 * LIVENESS_TIMEOUT_MS + 2 * S);
        expect(stalled).toHaveBeenCalledTimes(1);
        resume(); // the ask out answers at once
        await vi.advanceTimersByTimeAsync(0);
        expect(answered).toHaveBeenCalledTimes(1);
        expect(answered).toHaveBeenCalledWith(11);
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS * 3);
        expect(answered).toHaveBeenCalledTimes(1);
        expect(stalled).toHaveBeenCalledTimes(1);
        w.stop();
    });

    it('one miss alone never warns', async () => {
        const { w, state, stalled, resume } = rig();
        w.start();
        state.alive = false;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + LIVENESS_TIMEOUT_MS + S); // one miss
        resume();
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS * 4);
        expect(stalled).not.toHaveBeenCalled();
        w.stop();
    });

    it('not asked (a relaunch, the pipeline down) is no miss and withdraws a warning', async () => {
        const { w, state, stalled, answered } = rig();
        w.start();
        state.notAsked = true;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS * 6);
        expect(stalled).not.toHaveBeenCalled();
        state.notAsked = false;
        state.alive = false;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + 2 * LIVENESS_TIMEOUT_MS + S);
        expect(stalled).toHaveBeenCalledTimes(1);
        state.notAsked = true;
        await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS + S);
        expect(answered).toHaveBeenCalledTimes(1);
        w.stop();
    });

    it('stop() ends the asks, and an ask still out answers nobody', async () => {
        const { w, state, stalled } = rig();
        w.start();
        state.alive = false;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + LIVENESS_TIMEOUT_MS + 1);
        w.stop();
        const asked = state.asked;
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS * 4);
        expect(state.asked).toBe(asked);
        expect(stalled).not.toHaveBeenCalled();
    });

    it("an ask that throws is a miss, and is not repeated sooner than an ask's budget", async () => {
        vi.useFakeTimers();
        const stalled = vi.fn();
        const w = new RunnerLiveness({
            ask: () => Promise.reject(new Error('Runner exited')),
            stalled,
            answered: vi.fn(),
        });
        w.start();
        await vi.advanceTimersByTimeAsync(LIVENESS_PERIOD_MS + 1);
        expect(stalled).not.toHaveBeenCalled(); // one miss; the next ask waits out the budget
        await vi.advanceTimersByTimeAsync(LIVENESS_TIMEOUT_MS);
        expect(stalled).toHaveBeenCalledTimes(1);
        w.stop();
    });
});

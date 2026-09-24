import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VuStallWatch } from './VuStallWatch.js';

describe('VuStallWatch', () => {
    let onStall: ReturnType<typeof vi.fn>;
    let onResume: ReturnType<typeof vi.fn>;
    let watch: VuStallWatch;

    beforeEach(() => {
        vi.useFakeTimers();
        onStall = vi.fn();
        onResume = vi.fn();
        watch = new VuStallWatch({ onStall, onResume });
    });

    afterEach(() => {
        watch.reset();
        vi.useRealTimers();
    });

    it('stays quiet while readings keep arriving at the 1 s heartbeat', () => {
        for (let i = 0; i < 10; i++) {
            watch.tick();
            vi.advanceTimersByTime(1100);
        }
        expect(onStall).not.toHaveBeenCalled();
    });

    it('warns once when readings stop for longer than staleMs, then reports the resume gap', () => {
        watch.tick();
        vi.advanceTimersByTime(6000);
        expect(onStall).toHaveBeenCalledTimes(1);
        expect(onStall.mock.calls[0][0]).toBeGreaterThan(2500);

        watch.tick();
        expect(onResume).toHaveBeenCalledTimes(1);
        expect(onResume.mock.calls[0][0]).toBeGreaterThanOrEqual(6000);

        vi.advanceTimersByTime(1000);
        expect(onStall).toHaveBeenCalledTimes(1); // fresh reading re-armed, no second warning yet
    });

    it('never warns for a module that was never metered or that was reset (stopped)', () => {
        vi.advanceTimersByTime(10_000);
        expect(onStall).not.toHaveBeenCalled();

        watch.tick();
        watch.reset();
        vi.advanceTimersByTime(10_000);
        expect(onStall).not.toHaveBeenCalled();
    });
});

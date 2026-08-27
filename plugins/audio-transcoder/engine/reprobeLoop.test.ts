import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReprobeLoop, REPROBE_INTERVAL_MS } from './reprobeLoop.js';

/** Deferred probe so a tick can be held mid-flight. */
function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

function makeLoop(probe: () => Promise<any>) {
    const degraded = vi.fn();
    const restart = vi.fn(async () => {});
    const loop = new ReprobeLoop({ probe, degraded, restart });
    return { loop, degraded, restart };
}

describe('ReprobeLoop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-asserts the degraded warning and keeps waiting while the codec is unknown', async () => {
        const probe = vi.fn(async () => ({ codec: 'unknown', rawCaps: '' }));
        const { loop, degraded, restart } = makeLoop(probe);
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);

        expect(probe).toHaveBeenCalledTimes(3);
        expect(degraded).toHaveBeenCalledTimes(3);
        expect(restart).not.toHaveBeenCalled();
        expect(loop.armed).toBe(true);
        loop.disarm();
    });

    it('treats "nothing wired" (null probe) as still-unknown, never a restart', async () => {
        const { loop, degraded, restart } = makeLoop(async () => null);
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);

        expect(degraded).toHaveBeenCalledTimes(1);
        expect(restart).not.toHaveBeenCalled();
        loop.disarm();
    });

    it('disarms and restarts once a real codec comes back', async () => {
        const codecs = ['unknown', 'aac'];
        const { loop, degraded, restart } = makeLoop(async () => ({
            codec: codecs.shift() ?? 'aac',
            rawCaps: '',
        }));
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 2);

        expect(degraded).toHaveBeenCalledTimes(1);
        expect(restart).toHaveBeenCalledTimes(1);
        expect(restart).toHaveBeenCalledWith({ codec: 'aac', rawCaps: '' });
        expect(loop.armed).toBe(false);

        // Timer is gone — no further probes, no second restart.
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('arm() is idempotent — re-arming does not stack a second timer', async () => {
        const probe = vi.fn(async () => ({ codec: 'unknown', rawCaps: '' }));
        const { loop } = makeLoop(probe);
        loop.arm();
        loop.arm();
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);

        expect(probe).toHaveBeenCalledTimes(1);
        loop.disarm();
    });

    it('skips a tick while a probe is still in flight (never overlaps)', async () => {
        const first = deferred<any>();
        const probe = vi.fn(() => first.promise);
        const { loop, degraded } = makeLoop(probe);
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(probe).toHaveBeenCalledTimes(1);

        first.resolve({ codec: 'unknown', rawCaps: '' });
        await vi.advanceTimersByTimeAsync(0);
        expect(degraded).toHaveBeenCalledTimes(1);
        loop.disarm();
    });

    it('a disarm landing mid-probe abandons that tick — no restart after stop', async () => {
        const pending = deferred<any>();
        const { loop, degraded, restart } = makeLoop(() => pending.promise);
        loop.arm();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        // Module stopped while the probe was running, then the probe answers
        // with a real codec: the answer is stale and must be dropped.
        loop.disarm();
        pending.resolve({ codec: 'aac', rawCaps: '' });
        await vi.advanceTimersByTimeAsync(0);

        expect(restart).not.toHaveBeenCalled();
        expect(degraded).not.toHaveBeenCalled();
        expect(loop.armed).toBe(false);
    });
});

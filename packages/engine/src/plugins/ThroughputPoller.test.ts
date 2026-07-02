import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThroughputPoller, type ThroughputSample } from './ThroughputPoller.js';

describe('ThroughputPoller', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('computes bitrate from the byte delta over the elapsed interval', async () => {
        const samples: ThroughputSample[] = [];
        // 250 kB then 500 kB — 250 kB over each 2 s interval = 1000 kbps.
        const getBytes = vi
            .fn<() => Promise<number | undefined>>()
            .mockResolvedValueOnce(250_000)
            .mockResolvedValueOnce(500_000);
        const poller = new ThroughputPoller({ getBytes, publish: (s) => samples.push(s) });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();

        expect(samples).toEqual([
            { bitrateKbps: 1000, totalBytes: 250_000 },
            { bitrateKbps: 1000, totalBytes: 500_000 },
        ]);
    });

    it('treats a counter drop as a reset — never reports a negative rate', async () => {
        const samples: ThroughputSample[] = [];
        // Second sample is BELOW the first: the child was re-spawned and udpsink
        // reset bytes-served. Delta must clamp to 0, not go negative.
        const getBytes = vi
            .fn<() => Promise<number | undefined>>()
            .mockResolvedValueOnce(500_000)
            .mockResolvedValueOnce(100_000);
        const poller = new ThroughputPoller({ getBytes, publish: (s) => samples.push(s) });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();

        expect(samples[1]).toEqual({ bitrateKbps: 0, totalBytes: 100_000 });
    });

    it('skips the tick (no publish) while the byte counter is unavailable', async () => {
        const publish = vi.fn();
        const getBytes = vi
            .fn<() => Promise<number | undefined>>()
            .mockResolvedValueOnce(undefined) // idle — skip
            .mockResolvedValueOnce(undefined) // still idle — skip
            .mockResolvedValueOnce(100_000); // now producing — publish
        const poller = new ThroughputPoller({ getBytes, publish });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(publish).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish.mock.calls[0][0]).toMatchObject({ totalBytes: 100_000 });
    });

    it('swallows a throwing reader and keeps polling', async () => {
        const publish = vi.fn();
        const getBytes = vi
            .fn<() => Promise<number | undefined>>()
            .mockRejectedValueOnce(new Error('rpc timeout'))
            .mockResolvedValueOnce(80_000);
        const poller = new ThroughputPoller({ getBytes, publish });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        expect(publish).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();
        expect(publish).toHaveBeenCalledTimes(1);
    });

    it('honours a custom interval and stops cleanly', async () => {
        const publish = vi.fn();
        const getBytes = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(1000);
        const poller = new ThroughputPoller({ getBytes, publish, intervalMs: 500 });
        poller.start();

        await vi.advanceTimersByTimeAsync(500);
        expect(publish).toHaveBeenCalledTimes(1);
        poller.stop();
        await vi.advanceTimersByTimeAsync(2000);
        expect(publish).toHaveBeenCalledTimes(1); // no further ticks after stop
    });
});

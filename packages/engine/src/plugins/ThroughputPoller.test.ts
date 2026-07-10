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

    it('aggregates named counters into the total and reports each separately', async () => {
        const calls: Array<{ total: ThroughputSample; counters: Record<string, ThroughputSample> }> =
            [];
        // Two renditions over one 2s tick: 625 kB → 2500 kbps, 200 kB → 800 kbps.
        const getBytes = vi
            .fn<() => Promise<Record<string, number> | undefined>>()
            .mockResolvedValueOnce({ usink_0: 625_000, usink_1: 200_000 });
        const poller = new ThroughputPoller({
            getBytes,
            publish: (total, counters) => calls.push({ total, counters }),
        });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();

        expect(calls[0].counters).toEqual({
            usink_0: { bitrateKbps: 2500, totalBytes: 625_000 },
            usink_1: { bitrateKbps: 800, totalBytes: 200_000 },
        });
        expect(calls[0].total).toEqual({ bitrateKbps: 3300, totalBytes: 825_000 });
    });

    it('skips the tick for an empty counter record — same contract as undefined', async () => {
        const publish = vi.fn();
        const getBytes = vi
            .fn<() => Promise<Record<string, number> | undefined>>()
            .mockResolvedValueOnce({});
        const poller = new ThroughputPoller({ getBytes, publish });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();
        expect(publish).not.toHaveBeenCalled();
    });

    it('guards each counter reset independently', async () => {
        const calls: Array<Record<string, ThroughputSample>> = [];
        // usink_0 keeps counting; usink_1 drops below its baseline (child
        // re-spawn) and must clamp to 0 without disturbing usink_0's rate.
        const getBytes = vi
            .fn<() => Promise<Record<string, number> | undefined>>()
            .mockResolvedValueOnce({ usink_0: 250_000, usink_1: 500_000 })
            .mockResolvedValueOnce({ usink_0: 500_000, usink_1: 100_000 });
        const poller = new ThroughputPoller({
            getBytes,
            publish: (_total, counters) => calls.push(counters),
        });
        poller.start();

        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        poller.stop();

        expect(calls[1].usink_0).toEqual({ bitrateKbps: 1000, totalBytes: 500_000 });
        expect(calls[1].usink_1).toEqual({ bitrateKbps: 0, totalBytes: 100_000 });
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

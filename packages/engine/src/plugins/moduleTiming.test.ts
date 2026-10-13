import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModuleTiming, inputLabel } from './moduleTiming.js';
import { busEdgeSocketPath, buildBusSink, latInName, shortHash } from './busHelpers.js';
import { setLatenessTapAvailable } from './latenessTap.js';

const MS = 1_000_000;
/** An `mrlateness` message payload as the runners forward it. */
const win = (meanMs: number, minMs = meanMs, maxMs = meanMs, count = 100) => ({
    count,
    untimed: 0,
    'min-ns': minMs * MS,
    'mean-ns': meanMs * MS,
    'max-ns': maxMs * MS,
    'last-ns': meanMs * MS,
    'interval-ns': 2000 * MS,
    reference: 'house',
});

describe('ModuleTiming', () => {
    afterEach(() => {
        vi.useRealTimers();
        setLatenessTapAvailable(true);
    });

    it('emits state only when the display changes (R-P0-6)', () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const t = new ModuleTiming({
            emit,
            getProperty: async () => undefined,
            busSources: () => [],
        });
        t.start({ pipeline: 'videotestsrc ! fakesink' });
        expect(emit).not.toHaveBeenCalled();
        t.onEvent('mrlateness:lat_busout_1', win(40));
        vi.advanceTimersByTime(2000);
        expect(emit).toHaveBeenCalledTimes(1);
        expect(t.publication.badge?.text).toBe('40 ms');
        t.onEvent('mrlateness:lat_busout_1', win(40.4));
        vi.advanceTimersByTime(2000);
        expect(emit).toHaveBeenCalledTimes(1);
        t.onEvent('mrlateness:lat_busout_1', win(43));
        vi.advanceTimersByTime(2000);
        expect(emit).toHaveBeenCalledTimes(2);
        t.stop();
        expect(emit).toHaveBeenCalledTimes(3);
        expect(t.publication.sections).toEqual([]);
    });

    it('a bus module without the instrument says so at start', () => {
        setLatenessTapAvailable(false);
        const emit = vi.fn();
        const t = new ModuleTiming({
            emit,
            getProperty: async () => undefined,
            busSources: () => [],
        });
        t.start({ pipeline: `audiotestsrc ! ${buildBusSink(41000)}` });
        expect(t.publication.data.timing).toEqual({ instrument: 'lateness instrument missing' });
        t.stop(false);
    });

    it('reads D and the audio ring from the named sink at PLAYING', async () => {
        const props: Record<string, number> = { 'ts-offset': 60 * MS, 'buffer-time': 100_000 };
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async (_el, prop) => props[prop],
            busSources: () => [],
        });
        t.start({ pipeline: 'fakesrc ! fakesink', timingSink: { element: 'sink', kind: 'audio' } });
        t.onPlaying();
        await new Promise((r) => setImmediate(r));
        t.onEvent('mrlateness:lat_render', win(20));
        t.tick();
        expect(t.publication.data.timing).toMatchObject({
            presentationDelayMs: 60,
            deviceLatencyMs: 100,
            renderMs: 160,
        });
        t.stop(false);
    });
});

describe('PipeWire-graph modules (WI-P0-10)', () => {
    it('show the worst latency PipeWire reports for their nodes, and stop with the module', async () => {
        vi.useFakeTimers();
        const emit = vi.fn();
        const t = new ModuleTiming({
            emit,
            getProperty: async () => undefined,
            busSources: () => [],
        });
        t.start(null);
        const read = vi.fn(async (names: string[]) => {
            expect(names).toEqual(['MR_PW_m_out_0', 'MR_PW_m_out_1']);
            return new Map([
                ['MR_PW_m_out_0', { quantum: 1024, rate: 48000, latencyMs: 21.33 }],
                ['MR_PW_m_out_1', { quantum: 2048, rate: 48000, latencyMs: 42.67 }],
            ]);
        });
        t.watchPipeWire(['MR_PW_m_out_0', 'MR_PW_m_out_1'], read);
        await vi.advanceTimersByTimeAsync(0);
        expect(t.publication.data.timing).toEqual({ pipeWireLatencyMs: 43 });
        expect(t.publication.badge?.text).toBe('43 ms');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(read).toHaveBeenCalledTimes(2);
        t.stop();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(read).toHaveBeenCalledTimes(2);
        expect(t.publication.sections).toEqual([]);
        vi.useRealTimers();
    });
});

describe('inputLabel', () => {
    it('names an edge-keyed tap by the module feeding it', () => {
        const socketPath = busEdgeSocketPath(41000, 'srt-1:out-dec-1:in');
        const src = { port: 41000, socketPath, sourceModuleId: 'srt-1', sinkPortId: 'mpegts-in' };
        const other = { ...src, port: 41001, socketPath: '/tmp/x.sock', sourceModuleId: 'rist-2' };
        const tap = latInName(`41000_${shortHash(socketPath)}`);
        expect(inputLabel(tap, [other, src])).toBe('srt-1 (mpegts-in)');
        expect(inputLabel('lat_busin_3', [other, src])).toBe('busin_3');
        expect(inputLabel('lat_busin', [src])).toBe('srt-1 (mpegts-in)');
    });
});

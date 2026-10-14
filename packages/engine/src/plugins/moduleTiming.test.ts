import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModuleTiming, busInputs, type BusSourceRef } from './moduleTiming.js';
import {
    busEdgeSocketPath,
    buildBusSink,
    buildBusSrc,
    latInName,
    shortHash,
} from './busHelpers.js';
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

    it('a video sink adds one refresh of its output mode; with the mode unknown, 60 Hz and says so', async () => {
        const deviceRow = async (refreshHz?: number) => {
            const t = new ModuleTiming({
                emit: () => {},
                getProperty: async () => 0,
                busSources: () => [],
            });
            const sink = {
                element: 'sink',
                kind: 'video' as const,
                ...(refreshHz ? { refreshHz } : {}),
            };
            t.start({ pipeline: 'fakesrc ! fakesink', timingSink: sink });
            t.onPlaying();
            await new Promise((r) => setImmediate(r));
            t.onEvent('mrlateness:lat_render', win(10));
            t.tick();
            const timing = t.publication.sections.find((s) => s.id === 'timing')!;
            const field = timing.fields.find((f) => f.key === 'deviceLatencyMs');
            const value = t.publication.data.timing;
            t.stop(false);
            return [field?.label, value.deviceLatencyMs, value.renderMs];
        };
        expect(await deviceRow(50)).toEqual(['Device latency', 20, 30]);
        expect(await deviceRow(59.94)).toEqual(['Device latency', 17, 27]);
        expect(await deviceRow()).toEqual(['Device latency (60 Hz assumed)', 17, 27]);
    });

    it('takes a sidecar stats-line window (ms) under the tap it stands for', () => {
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => [],
        });
        t.start(null);
        // mrts::lateness_json_ms, byte for byte (lateness_test.cpp test_json).
        const line = '{"count":2,"untimed":1,"min":-1.500,"mean":0.500,"max":2.500}';
        t.addSidecarWindow('lat_busout_41000', JSON.parse(line));
        t.addSidecarWindow('lat_busout_41000', { count: 0, untimed: 4, min: 0, mean: 0, max: 0 });
        t.tick();
        expect(t.publication.data.timing).toEqual({ outputMs: 1, outputRange: '-1 – 3' });
        // A window with no samples, or not a window at all, changes nothing.
        t.addSidecarWindow('lat_busout_41000', { count: 3, mean: 'n/a' });
        t.addSidecarWindow('lat_busout_41000', undefined);
        t.tick();
        expect(t.publication.data.timing).toEqual({ outputMs: 1, outputRange: '-1 – 3' });
        t.stop(false);
    });
});

describe('input numbering (F8)', () => {
    afterEach(() => vi.useRealTimers());
    const edge = (port: number, sourceModuleId: string, sinkPortId: string): BusSourceRef => {
        const connectionId = `${sourceModuleId}:out-mix-1:${sinkPortId}`;
        return {
            port,
            socketPath: busEdgeSocketPath(port, connectionId),
            sourceModuleId,
            sinkPortId,
            connectionId,
        };
    };
    /** The tap `buildBusSrc` gives this edge, read back out of the fragment it builds. */
    const tapOf = (s: BusSourceRef) =>
        /mrlateness name=(\S+)/.exec(buildBusSrc({ port: s.port, socketPath: s.socketPath }))![1];
    const a = edge(41000, 'enc-a', 'in-0');
    const b = edge(41001, 'enc-b', 'in-1');
    const c = edge(41002, 'enc-c', 'in-10');
    const d = edge(41003, 'enc-d', 'in-2');

    it('numbers bus inputs by sink port (in-2 before in-10), each under its edge tap', () => {
        expect(busInputs([c, d, b, a])).toEqual([
            { tap: tapOf(a), n: 1, label: 'enc-a (in-0)' },
            { tap: tapOf(b), n: 2, label: 'enc-b (in-1)' },
            { tap: tapOf(d), n: 3, label: 'enc-d (in-2)' },
            { tap: tapOf(c), n: 4, label: 'enc-c (in-10)' },
        ]);
        // One port with many connections: by connection id.
        const x = edge(42000, 'src-x', 'audio-in');
        const y = edge(42001, 'src-y', 'audio-in');
        expect(busInputs([y, x]).map((i) => i.label)).toEqual([
            'src-x (audio-in)',
            'src-y (audio-in)',
        ]);
        expect(tapOf(a)).toBe(latInName(`41000_${shortHash(a.socketPath)}`));
    });

    it('a producer that stops leaves the router list; the inputs after it keep their numbers', () => {
        vi.useFakeTimers();
        let sources = [a, b, d];
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => sources,
        });
        const inputSections = () =>
            t.publication.sections.filter((s) => s.id.startsWith('timing-in-'));
        t.start({ pipeline: 'audiomixer ! fakesink' });
        for (const s of [a, b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10));
        vi.advanceTimersByTime(2000);
        expect(inputSections().map((s) => s.label)).toEqual([
            'Input 1 timing: enc-a (in-0)',
            'Input 2 timing: enc-b (in-1)',
            'Input 3 timing: enc-d (in-2)',
        ]);
        // enc-a stops: its channel is released, so the router no longer lists it.
        sources = [b, d];
        for (let i = 0; i < 4; i++) {
            for (const s of [b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10 + i));
            vi.advanceTimersByTime(2000);
        }
        expect(inputSections().map((s) => s.id)).toEqual(['timing-in-2', 'timing-in-3']);
        expect(t.publication.data['timing-in-2']).toMatchObject({ latenessMs: 13 });
        // A restart numbers the inputs it is built with.
        t.start({ pipeline: 'audiomixer ! fakesink' });
        for (const s of [b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10));
        t.tick();
        expect(inputSections().map((s) => s.id)).toEqual(['timing-in-1', 'timing-in-2']);
        t.stop(false);
    });

    it('a module that names its taps per branch declares their numbers and labels', () => {
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => [a, b],
        });
        t.start({
            pipeline: 'mpegtsmux ! fakesink',
            timingInputs: [
                { tap: 'lat_busin_0', n: 1, label: 'enc-a (input-0)' },
                { tap: 'lat_busin_1', n: 3, label: 'enc-b (input-2)' },
            ],
        });
        t.onEvent('mrlateness:lat_busin_0', win(20));
        t.onEvent('mrlateness:lat_busin_1', win(140));
        t.onEvent('mrlateness:lat_busout_40010', win(300));
        t.tick();
        expect(t.publication.sections.map((s) => [s.id, s.label])).toEqual([
            ['timing', 'Timing'],
            ['timing-in-1', 'Input 1 timing: enc-a (input-0)'],
            ['timing-in-3', 'Input 3 timing: enc-b (input-2)'],
        ]);
        expect(t.publication.data.timing).toMatchObject({ slowest: 'enc-b (input-2)' });
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

describe('input labels', () => {
    /** The input section one tap gets on a module fed by `sources`. */
    const sectionFor = (sources: BusSourceRef[], tap: string): string | undefined => {
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => sources,
        });
        t.start(null);
        t.onEvent(`mrlateness:${tap}`, win(5));
        t.tick();
        const label = t.publication.sections.find((s) => s.id.startsWith('timing-in-'))?.label;
        t.stop(false);
        return label;
    };

    it('names an input by the module feeding it, a single-input module whatever its tap', () => {
        const conn = 'srt-1:out-dec-1:in';
        const socketPath = busEdgeSocketPath(41000, conn);
        const src = { port: 41000, socketPath, sourceModuleId: 'srt-1', sinkPortId: 'mpegts-in' };
        const other = { ...src, port: 41001, socketPath: '/tmp/x.sock', sourceModuleId: 'rist-2' };
        const both = [
            { ...other, connectionId: 'rist-2:out-dec-1:in' },
            { ...src, connectionId: conn },
        ];
        const tap = latInName(`41000_${shortHash(socketPath)}`);
        expect(sectionFor(both, tap)).toBe('Input 2 timing: srt-1 (mpegts-in)');
        expect(sectionFor(both, 'lat_busin_3')).toBe('Input 3 timing: busin_3');
        expect(sectionFor([both[1]], 'lat_busin')).toBe('Input 1 timing: srt-1 (mpegts-in)');
    });
});

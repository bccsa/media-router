import { describe, it, expect, vi, afterEach } from 'vitest';
import { LatenessReporter, parseLatenessPayload } from './latenessReporter.js';
import { timingChanged, timingPublication } from './timingSections.js';
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

describe('LatenessReporter', () => {
    it('parses a window, and ignores one that carried only untimed buffers', () => {
        expect(parseLatenessPayload(win(312, 290, 330))).toEqual({
            count: 100,
            meanMs: 312,
            minMs: 290,
            maxMs: 330,
        });
        expect(parseLatenessPayload({ count: 0, untimed: 5 })).toBeNull();
        const r = new LatenessReporter();
        expect(r.onEvent('level:lvl', {})).toBe(false);
        expect(r.onEvent('mrlateness:lat_busin', { count: 0, untimed: 3 })).toBe(true);
        expect(r.summary().inputs).toEqual([]);
    });

    it('single-input transform: added latency = out − in', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin', win(40), 1000);
        r.onEvent('mrlateness:lat_busout_41000', win(88, 80, 95), 1000);
        const s = r.summary(1000);
        expect(s.output).toEqual({ meanMs: 88, minMs: 80, maxMs: 95 });
        expect(s.inputs).toHaveLength(1);
        expect(s.inputs[0].addedMs).toBe(48);
        expect(s.slowest).toBeUndefined();
        const rows = timingPublication(s).data.timing;
        expect(rows).toMatchObject({ outputMs: 88, outputRange: '80 – 95', addedMs: 48 });
    });

    it('a 3-input muxer names its slowest input and merges nothing across inputs', () => {
        const r = new LatenessReporter({ labelFor: (t) => t.replace('lat_', '') });
        r.onEvent('mrlateness:lat_busin_0', win(20));
        r.onEvent('mrlateness:lat_busin_1', win(140));
        r.onEvent('mrlateness:lat_busin_2', win(65));
        r.onEvent('mrlateness:lat_busout_40010', win(300));
        const s = r.summary();
        expect(s.slowest).toBe('busin_1');
        expect(s.inputs.map((i) => i.addedMs)).toEqual([280, 160, 235]);
        const pub = timingPublication(s);
        // Added latency in the main section is against the input it waits for.
        expect(pub.data.timing).toMatchObject({ addedMs: 160, slowest: 'busin_1' });
        expect(pub.sections.map((x) => x.id)).toEqual([
            'timing',
            'timing-in-1',
            'timing-in-2',
            'timing-in-3',
        ]);
        expect(pub.data['timing-in-2']).toMatchObject({ latenessMs: 140, addedMs: 160 });
    });

    it('an output with D = 60 ms and λ = 20 ms renders at 60 + device', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin_41000_abcdef', win(5));
        r.onEvent('mrlateness:lat_render', win(20));
        r.setPresentation({ presentationDelayMs: 60, deviceLatencyMs: 100 });
        const s = r.summary();
        expect(s.output?.meanMs).toBe(20);
        expect(s.decodeMs).toBe(15);
        expect(s.renderMs).toBe(160);
        expect(timingPublication(s).badge).toEqual({
            id: 'lateness',
            icon: 'timer',
            text: '160 ms',
            color: '#6b7280',
        });
    });

    it('λ = 150 ms past D renders at 150 + device', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_render', win(150));
        r.setPresentation({ presentationDelayMs: 60, deviceLatencyMs: 100 });
        expect(r.summary().renderMs).toBe(250);
    });

    it('a network output reads lat_egress as its output and shows no render rows', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin', win(10));
        r.onEvent('mrlateness:lat_egress', win(12));
        const s = r.summary();
        expect(s.output?.meanMs).toBe(12);
        expect(s.renderMs).toBeUndefined();
        expect(s.inputs[0].addedMs).toBe(2);
    });

    it('every row carries a label and every number a unit', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin_0', win(5));
        r.onEvent('mrlateness:lat_busin_1', win(9));
        r.onEvent('mrlateness:lat_render', win(20));
        r.setPresentation({ presentationDelayMs: 60, deviceLatencyMs: 100 });
        r.setPipeWireLatency(21.3);
        const pub = timingPublication(r.summary());
        const timing = pub.sections.find((x) => x.id === 'timing')!;
        expect(timing.fields.map((f) => f.label)).toEqual([
            'Output lateness',
            'Output lateness min – max',
            'Added latency',
            'Slowest input',
            'Decode',
            'Presentation delay',
            'Device latency',
            'Render lateness',
            'PipeWire latency',
        ]);
        for (const sec of pub.sections) {
            for (const f of sec.fields) {
                expect(f.label.length).toBeGreaterThan(0);
                const v = pub.data[sec.id][f.key];
                if (typeof v === 'number' || f.key.endsWith('Range')) expect(f.unit).toBe('ms');
            }
        }
    });

    it('drops a tap that stopped reporting (input removed or dark)', () => {
        const r = new LatenessReporter({ intervalMs: 2000 });
        r.onEvent('mrlateness:lat_busin_0', win(5), 0);
        r.onEvent('mrlateness:lat_busin_1', win(9), 5000);
        expect(r.summary(5000).inputs).toHaveLength(2);
        expect(r.summary(7000).inputs.map((i) => i.tap)).toEqual(['lat_busin_1']);
    });

    it('does not show a window that is off the house timeline (an unarmed egress)', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busout_41000', win(12));
        expect(r.summary().output?.meanMs).toBe(12);
        // Raw mux PTS before the first consumer arms the stamper: ~uptime late.
        r.onEvent('mrlateness:lat_busout_41000', win(2_108_445_230));
        expect(r.summary().output).toBeUndefined();
    });

    it('says the instrument is missing instead of showing nothing', () => {
        const r = new LatenessReporter();
        r.setInstrument(false);
        expect(timingPublication(r.summary()).data.timing).toEqual({
            instrument: 'lateness instrument missing',
        });
    });
});

describe('throttling (R-P0-6)', () => {
    afterEach(() => {
        vi.useRealTimers();
        setLatenessTapAvailable(true);
    });

    it('a change below 1 ms is not a change; 1 ms or a new row is', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin', win(40), 0);
        const a = r.summary(0);
        r.onEvent('mrlateness:lat_busin', win(40.6), 0);
        expect(timingChanged(a, r.summary(0))).toBe(false);
        r.onEvent('mrlateness:lat_busin', win(41.2), 0);
        expect(timingChanged(a, r.summary(0))).toBe(true);
        r.onEvent('mrlateness:lat_busin', win(40), 0);
        r.onEvent('mrlateness:lat_busout_1', win(50), 0);
        expect(timingChanged(a, r.summary(0))).toBe(true);
    });

    it('ModuleTiming emits state only when the display changes', () => {
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

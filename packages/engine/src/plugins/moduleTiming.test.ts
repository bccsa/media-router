import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    ModuleTiming,
    alignerInputFor,
    edgeTapName,
    inputLabel,
    type ModuleTimingHost,
} from './moduleTiming.js';
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

describe('processing latency (OQ-22)', () => {
    it('shows from the next tick, and a start or stop clears it', () => {
        vi.useFakeTimers();
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => [],
        });
        t.start(null);
        t.setProcessingLatency(5);
        expect(t.publication.data.timing).toBeUndefined();
        vi.advanceTimersByTime(2000);
        expect(t.publication.data.timing).toEqual({ processingLatencyMs: 5 });
        t.start(null);
        expect(t.publication.data.timing).toBeUndefined();
        t.setProcessingLatency(20);
        t.stop(false);
        t.tick();
        expect(t.publication.data.timing).toBeUndefined();
        vi.useRealTimers();
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
        const connectionId = 'srt-1:out-dec-1:in';
        const socketPath = busEdgeSocketPath(41000, connectionId);
        const src = {
            port: 41000,
            socketPath,
            connectionId,
            sourceModuleId: 'srt-1',
            sinkPortId: 'mpegts-in',
        };
        const other = { ...src, port: 41001, socketPath: '/tmp/x.sock', sourceModuleId: 'rist-2' };
        const tap = latInName(`41000_${shortHash(socketPath)}`);
        expect(edgeTapName(src)).toBe(tap);
        expect(inputLabel(tap, [other, src])).toBe('srt-1 (mpegts-in)');
        expect(inputLabel('lat_busin_3', [other, src])).toBe('busin_3');
        expect(inputLabel('lat_busin', [src])).toBe('srt-1 (mpegts-in)');
    });
});

/** An `mralignwatch` payload as the runners forward it. */
const awMsg = (
    input: string,
    state: 'waiting' | 'present' | 'absent',
    o: {
        reason?: string;
        latenessMs?: number;
        paceMs?: number;
        staleMs?: number;
        absences?: number;
    } = {},
) => ({
    reason: o.reason ?? 'state',
    aligner: 'mixin',
    input,
    state,
    lateness: (o.latenessMs ?? 0) * MS,
    pace: (o.paceMs ?? 0) * MS,
    'silence-limit': 100 * MS,
    absences: o.absences ?? 0,
    'stale-buffers': 0,
    'stale-time': (o.staleMs ?? 0) * MS,
    gaps: 0,
    'level-time': 0,
    'level-bytes': 0,
    'full-count': 0,
});

describe('aligner inputs (WI-P2-13)', () => {
    const edge = (connectionId: string, port: number, sourceModuleId: string) => ({
        port,
        connectionId,
        socketPath: busEdgeSocketPath(port, connectionId),
        sourceModuleId,
        sinkPortId: 'audio-in',
    });
    const A = edge('enc-a:out-mix:audio-in', 41000, 'enc-a');
    const B = edge('enc-b:out-mix:audio-in', 41001, 'enc-b');

    function make(sources = [A, B], alignerInput?: ModuleTimingHost['alignerInput']) {
        const host = {
            emit: vi.fn(),
            getProperty: async () => undefined,
            busSources: vi.fn(() => sources),
            alignerWarnings: vi.fn(),
            log: vi.fn(),
            ...(alignerInput ? { alignerInput } : {}),
        };
        const t = new ModuleTiming(host);
        t.start({ pipeline: 'unixfdsrc ! fakesink' });
        host.emit.mockClear();
        host.alignerWarnings.mockClear();
        return { t, host };
    }

    it('a state change is published at once, with its warning, not at the next tick', () => {
        vi.useFakeTimers();
        const { t, host } = make();
        t.onEvent(
            'mralignwatch:mixin_aw_a',
            awMsg(A.connectionId, 'present', { reason: 'interval' }),
        );
        expect(host.emit).toHaveBeenCalledTimes(1);
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(null, null);
        t.onEvent('mralignwatch:mixin_aw_a', awMsg(A.connectionId, 'absent', { absences: 1 }));
        expect(host.emit).toHaveBeenCalledTimes(2);
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(
            'Input enc-a (audio-in) silent for 100 ms — continuing without it',
            null,
        );
        expect(t.publication.data['timing-in-1']).toMatchObject({ state: 'absent', absences: 1 });
        // An interval report that changes nothing waits for the tick.
        host.alignerWarnings.mockClear();
        t.onEvent(
            'mralignwatch:mixin_aw_a',
            awMsg(A.connectionId, 'absent', { reason: 'interval', absences: 1 }),
        );
        expect(host.alignerWarnings).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000);
        expect(host.alignerWarnings).toHaveBeenCalledTimes(1);
        t.stop(false);
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(null, null);
    });

    it("the engine's rule: a watch labelled with a connection id joins its edge's tap row", () => {
        const { t } = make();
        t.onEvent(`mrlateness:${edgeTapName(A)}`, win(12));
        t.onEvent(`mrlateness:${edgeTapName(B)}`, win(140));
        t.onEvent(
            'mralignwatch:mixin_aw_a',
            awMsg(A.connectionId, 'present', { latenessMs: 20, paceMs: 150 }),
        );
        t.onEvent(
            'mralignwatch:mixin_aw_b',
            awMsg(B.connectionId, 'present', { latenessMs: 150, paceMs: 150 }),
        );
        t.tick();
        const s = t.summary()!;
        expect(s.inputs.map((i) => [i.label, i.lateness?.meanMs, i.state])).toEqual([
            ['enc-a (audio-in)', 12, 'present'],
            ['enc-b (audio-in)', 140, 'present'],
        ]);
        expect(s).toMatchObject({ paceMs: 130, waitingFor: 'enc-b (audio-in)' });
        expect(alignerInputFor({ name: 'x', aligner: 'm', input: 'other' }, [A, B])).toEqual({
            label: 'other',
        });
        t.stop(false);
        expect(t.summary()).toBeUndefined();
    });

    it("a module's own answer wins, null keeps a watch out of the rows", () => {
        const own = vi.fn((w: { input: string }) =>
            w.input === 'in1' ? null : w.input === 'route' ? { tap: edgeTapName(A) } : undefined,
        );
        const { t } = make([A, B], own);
        t.onEvent('mralignwatch:omix0_aw1', awMsg('in1', 'absent'));
        t.onEvent('mralignwatch:aw_route', awMsg('route', 'present'));
        t.onEvent('mralignwatch:mixin_aw_b', awMsg(B.connectionId, 'present'));
        expect(t.summary()!.inputs.map((i) => [i.label, i.state])).toEqual([
            ['enc-a (audio-in)', 'present'],
            ['enc-b (audio-in)', 'present'],
        ]);
        t.stop(false);
    });

    it('a rejoin goes to the log naming the input, its absence and the stale ms', () => {
        vi.useFakeTimers();
        const { t, host } = make();
        const ch = 'mralignwatch:mixin_aw_a';
        vi.setSystemTime(0);
        t.onEvent(ch, awMsg(A.connectionId, 'present'));
        t.onEvent(ch, awMsg(A.connectionId, 'absent', { absences: 1 }));
        vi.setSystemTime(2500);
        t.onEvent(ch, awMsg(A.connectionId, 'present', { absences: 1, staleMs: 990.4 }));
        expect(host.log).not.toHaveBeenCalled();
        vi.setSystemTime(3500);
        t.onEvent(
            ch,
            awMsg(A.connectionId, 'present', { reason: 'interval', absences: 1, staleMs: 990.4 }),
        );
        expect(host.log).toHaveBeenCalledWith(
            'info',
            {
                alignerRejoin: {
                    name: 'mixin_aw_a',
                    aligner: 'mixin',
                    input: A.connectionId,
                    absentMs: 2500,
                    discardedMs: 990,
                },
            },
            'Input enc-a (audio-in) back after 2500 ms absent; 990 ms discarded as stale',
        );
        t.stop(false);
    });

    it('a late cue is a warn line with the pace raise', () => {
        const { t, host } = make();
        t.onEvent('mralignwatch:aw_k', {
            ...awMsg('demux_1_klv', 'present', { reason: 'late-cue', paceMs: 800 }),
            'cue-lateness': 800 * MS,
        });
        expect(host.log).toHaveBeenCalledWith(
            'warn',
            expect.objectContaining({ alignerLateCue: expect.objectContaining({ raisedMs: 800 }) }),
            'Input demux_1_klv: cue after its time, forwarded late, pace raised by 800 ms',
        );
        t.stop(false);
    });

    it('a removed edge: its watch names nothing and warns no more while it expires', () => {
        const sources = [A, B];
        const { t, host } = make(sources);
        t.onEvent('mralignwatch:mixin_aw_b', awMsg(B.connectionId, 'absent', { absences: 1 }));
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(
            expect.stringContaining('enc-b (audio-in)'),
            null,
        );
        sources.pop(); // the operator removed the dead input
        t.tick();
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(null, null);
        expect(t.summary()!.inputs).toEqual([]);
        t.stop(false);
    });
});

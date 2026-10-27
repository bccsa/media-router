import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    ModuleTiming,
    alignerInputFor,
    branchInputFor,
    busInputs,
    edgeTapName,
    type BusSourceRef,
    type ModuleTimingHost,
} from './moduleTiming.js';
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

    it('a window off the house timeline is a warn line, once per tap and run (B-26)', () => {
        const log = vi.fn();
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => [],
            log,
        });
        const hidden = (meanMs: number) => [
            'warn',
            { latenessOffTimeline: { tap: 'lat_busout_41000', meanMs } },
            `Lateness tap lat_busout_41000 read ${meanMs} ms, off the house timeline: not shown`,
        ];
        t.start({ pipeline: 'mpegtsmux ! tee name=busout_41000' });
        t.onEvent('mrlateness:lat_busout_41000', win(2_234_996_888.4));
        t.onEvent('mrlateness:lat_busout_41000', win(2_234_998_888));
        t.tick();
        expect(log.mock.calls).toEqual([hidden(2_234_996_888)]);
        expect(t.publication.data.timing).toBeUndefined();
        t.start({ pipeline: 'mpegtsmux ! tee name=busout_41000' });
        t.onEvent('mrlateness:lat_busout_41000', win(2_235_000_888));
        expect(log.mock.calls).toEqual([hidden(2_234_996_888), hidden(2_235_000_888)]);
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

    it('an input wired later takes the next number; none renumbers within the run (F8)', () => {
        let sources = [b, d];
        const t = new ModuleTiming({
            emit: () => {},
            getProperty: async () => undefined,
            busSources: () => sources,
        });
        const inputSections = () =>
            t.publication.sections
                .filter((s) => s.id.startsWith('timing-in-'))
                .map((s) => [s.id, s.label]);
        t.start({ pipeline: 'audiomixer ! fakesink' });
        for (const s of [b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10));
        t.tick();
        expect(inputSections()).toEqual([
            ['timing-in-1', 'Input 1 timing: enc-b (in-1)'],
            ['timing-in-2', 'Input 2 timing: enc-d (in-2)'],
        ]);
        // enc-a's edge sorts first (in-0): wired now, it is the third, the others keep theirs.
        sources = [a, b, d];
        for (const s of [a, b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10));
        t.tick();
        expect(inputSections()).toEqual([
            ['timing-in-1', 'Input 1 timing: enc-b (in-1)'],
            ['timing-in-2', 'Input 2 timing: enc-d (in-2)'],
            ['timing-in-3', 'Input 3 timing: enc-a (in-0)'],
        ]);
        // A restart numbers the inputs it is built with, in their order.
        t.start({ pipeline: 'audiomixer ! fakesink' });
        for (const s of [a, b, d]) t.onEvent(`mrlateness:${tapOf(s)}`, win(10));
        t.tick();
        expect(inputSections().map(([id]) => id)).toEqual([
            'timing-in-1',
            'timing-in-2',
            'timing-in-3',
        ]);
        expect(inputSections()[0][1]).toBe('Input 1 timing: enc-a (in-0)');
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
        expect(edgeTapName(src)).toBe(tap);
        expect(sectionFor(both, tap)).toBe('Input 2 timing: srt-1 (mpegts-in)');
        expect(sectionFor(both, 'lat_busin_3')).toBe('Input 3 timing: busin_3');
        expect(sectionFor([both[1]], 'lat_busin')).toBe('Input 1 timing: srt-1 (mpegts-in)');
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

    it('a pace fall is an info line with the fall and the steady window (B-82)', () => {
        const { t, host } = make();
        const fell = (fellMs: number, fallAfterMs: number) => ({
            ...awMsg(A.connectionId, 'present', { reason: 'pace-fell', paceMs: 20 }),
            'pace-target': 20 * MS,
            fell: fellMs * MS,
            'fall-after': fallAfterMs * MS,
        });
        t.onEvent('mralignwatch:mixin_aw_a', fell(280.4, 180_000));
        expect(host.log).toHaveBeenLastCalledWith(
            'info',
            {
                alignerPaceFell: {
                    name: 'mixin_aw_a',
                    aligner: 'mixin',
                    fellMs: 280,
                    fallAfterMs: 180_000,
                },
            },
            'Pace fell by 280 ms: every input steady for 3 min',
        );
        t.onEvent('mralignwatch:mixin_aw_a', fell(1000, 4000));
        expect(host.log).toHaveBeenLastCalledWith(
            'info',
            expect.anything(),
            'Pace fell by 1000 ms: every input steady for 4 s',
        );
        expect(host.log).toHaveBeenCalledTimes(2);
        t.stop(false);
    });

    it('a producer stopped while wired keeps its row: absent, warned, waited for (B-93)', () => {
        let sources = [A, B];
        const host = {
            emit: vi.fn(),
            getProperty: async () => undefined,
            busSources: vi.fn(() => sources),
            alignerWarnings: vi.fn(),
            log: vi.fn(),
            wired: vi.fn((s: BusSourceRef) => s.connectionId === B.connectionId),
        };
        const t = new ModuleTiming(host);
        t.start({ pipeline: 'unixfdsrc ! fakesink' });
        t.onEvent('mralignwatch:mixin_aw_a', awMsg(A.connectionId, 'present'));
        t.onEvent('mralignwatch:mixin_aw_b', awMsg(B.connectionId, 'present'));
        // enc-b stops: its channel is released and the router lists its edge no more; the edge
        // stands in the module's graph, and its watch goes absent.
        sources = [A];
        t.onEvent('mralignwatch:mixin_aw_b', awMsg(B.connectionId, 'absent', { absences: 1 }));
        const s = t.summary()!;
        expect(s.inputs.map((i) => [i.n, i.label, i.state])).toEqual([
            [1, 'enc-a (audio-in)', 'present'],
            [2, 'enc-b (audio-in)', 'absent'],
        ]);
        expect(s.waitingFor).toBe('enc-b (audio-in)');
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(
            'Input enc-b (audio-in) silent for 100 ms — continuing without it',
            null,
        );
        expect(host.wired).toHaveBeenCalledWith(
            expect.objectContaining({ connectionId: B.connectionId }),
        );
        t.stop(false);
    });

    it('an input whose tap went quiet under watches that report on shows absent (a dark muxer pin)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const pin = (input: string) =>
            input.startsWith('demux_0') ? { tap: 'lat_busin_0' } : undefined;
        const { t, host } = make([A, B], (w) => pin(w.input));
        t.start({
            pipeline: 'unixfdsrc ! fakesink',
            timingInputs: [{ tap: 'lat_busin_0', n: 1, label: 'enc-a (input-0)' }],
        });
        const route = (state: 'present' | 'absent') =>
            t.onEvent('mralignwatch:aw_demux_0_video', {
                ...awMsg('demux_0_video', state, { reason: 'interval', latenessMs: 150 }),
                aligner: 'mux',
            });
        t.onEvent('mrlateness:lat_busin_0', win(140));
        route('present');
        t.tick();
        expect(t.summary()!.inputs.map((i) => [i.n, i.label, i.state])).toEqual([
            [1, 'enc-a (input-0)', 'present'],
        ]);
        // The pin's producer stops: its routes end at EOS and report on as present; the tap goes
        // quiet, and once it is stale the row is absent, named and warned.
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(2000);
            route('present');
        }
        const s = t.summary()!;
        expect(s.inputs.map((i) => [i.n, i.state, i.lateness])).toEqual([[1, 'absent', undefined]]);
        expect(s.waitingFor).toBe('enc-a (input-0)');
        expect(host.alignerWarnings).toHaveBeenLastCalledWith(
            'Input enc-a (input-0) silent for 6000 ms — continuing without it',
            null,
        );
        // Before its first window a tap is not quiet: a fresh run shows the route present; nor is
        // one hidden as off the house timeline.
        t.start({
            pipeline: 'unixfdsrc ! fakesink',
            timingInputs: [{ tap: 'lat_busin_0', n: 1, label: 'enc-a (input-0)' }],
        });
        route('present');
        expect(t.summary()!.inputs.map((i) => i.state)).toEqual(['present']);
        t.onEvent('mrlateness:lat_busin_0', win(140));
        t.onEvent('mrlateness:lat_busin_0', win(4_000_000));
        route('present');
        expect(t.summary()!.inputs.map((i) => i.state)).toEqual(['present']);
        t.stop(false);
    });

    it('a removed edge: its watch names nothing and warns no more while it expires', () => {
        // Gone from the module's graph (no `wired`): the operator removed it.
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

describe('demuxes and consumer ASRCs (WI-P3-6)', () => {
    const edge = (connectionId: string, port: number, sinkPortId = 'audio-in') => ({
        port,
        connectionId,
        socketPath: busEdgeSocketPath(port, connectionId),
        sourceModuleId: connectionId.split(':')[0],
        sinkPortId,
    });
    const A = edge('enc-a:out-mix:audio-in', 41000);
    const B = edge('enc-b:out-mix:audio-in', 41001);
    const iv = (pes: number) => ({ reason: 'interval', stream: 'found', pes, generation: 0 });

    function make(
        sources: BusSourceRef[],
        demuxInput?: ModuleTimingHost['demuxInput'],
        pipeline = 'unixfdsrc ! fakesink',
    ) {
        const host = {
            emit: vi.fn(),
            getProperty: async () => undefined,
            busSources: vi.fn(() => sources),
            alignerWarnings: vi.fn(),
            streamWarnings: vi.fn(),
            log: vi.fn(),
            ...(demuxInput ? { demuxInput } : {}),
        };
        const t = new ModuleTiming(host);
        t.start({ pipeline });
        host.streamWarnings.mockClear();
        return { t, host };
    }
    const demuxRows = (t: ModuleTiming) =>
        t.summary()!.inputs.map((i) => [i.label, i.demux?.pesPerS ?? null]);

    it("the engine's rule: a branch named for its connection (a live fan-in) serves that edge", () => {
        vi.useFakeTimers();
        const { t } = make([A, B]);
        for (const [name, c] of [
            [`mixin_demux_${shortHash(B.connectionId)}`, 0],
            [`mixin_demux_${shortHash(B.connectionId)}`, 48],
        ] as const) {
            t.onEvent(`mrtsdemux:${name}`, iv(c));
            vi.advanceTimersByTime(1000);
        }
        t.onEvent(`mrlateness:${edgeTapName(A)}`, win(10));
        t.onEvent(`mrlateness:${edgeTapName(B)}`, win(10));
        t.tick();
        expect(demuxRows(t)).toEqual([
            ['enc-a (audio-in)', null],
            ['enc-b (audio-in)', 48],
        ]);
        expect(branchInputFor('mixin_demux_000000', [A, B])).toBeUndefined();
        expect(branchInputFor(`x_${shortHash(A.connectionId)}`, [A, B])).toEqual({
            tap: edgeTapName(A),
        });
        t.stop(false);
        vi.useRealTimers();
    });

    it("a stopped producer's demux stays on its input's row while the edge stands (B-93)", () => {
        vi.useFakeTimers();
        let sources = [A, B];
        const host = {
            emit: vi.fn(),
            getProperty: async () => undefined,
            busSources: vi.fn(() => sources),
            streamWarnings: vi.fn(),
            log: vi.fn(),
            wired: vi.fn((s: BusSourceRef) => s.connectionId === B.connectionId),
        };
        const t = new ModuleTiming(host);
        t.start({ pipeline: 'unixfdsrc ! fakesink' });
        const demuxB = `mixin_demux_${shortHash(B.connectionId)}`;
        for (const pes of [0, 48]) {
            t.onEvent(`mrtsdemux:${demuxB}`, iv(pes));
            vi.advanceTimersByTime(1000);
        }
        t.onEvent(`mrlateness:${edgeTapName(A)}`, win(10));
        t.onEvent(`mrlateness:${edgeTapName(B)}`, win(10));
        // enc-b stops: the router lists its edge no more; the edge stands in the module's graph.
        sources = [A];
        t.tick();
        expect(demuxRows(t)).toEqual([
            ['enc-a (audio-in)', null],
            ['enc-b (audio-in)', 48],
        ]);
        t.stop(false);
        vi.useRealTimers();
    });

    it("a module's answer: a connection or a sink port, resolved to its edge", () => {
        vi.useFakeTimers();
        const SUB = edge('ttx:out:subtitles-in', 41002, 'subtitles-in');
        const own = vi.fn((el: string) =>
            el === 'mixin_demux1'
                ? { connection: A.connectionId }
                : el === 'subdemux'
                  ? { port: 'subtitles-in' }
                  : el === 'probe'
                    ? null
                    : undefined,
        );
        const { t } = make([A, SUB], own);
        for (const pes of [0, 30]) {
            for (const el of ['mixin_demux1', 'subdemux', 'probe'])
                t.onEvent(`mrtsdemux:${el}`, iv(pes));
            vi.advanceTimersByTime(1000);
        }
        t.tick();
        expect(demuxRows(t)).toEqual([
            ['enc-a (audio-in)', 30],
            ['ttx (subtitles-in)', 30],
        ]);
        t.stop(false);
        vi.useRealTimers();
    });

    it('a program change goes to the log naming the input; the warnings to the module at once', () => {
        const { t, host } = make([A]);
        t.onEvent('mrlateness:lat_busin', win(10));
        t.onEvent('mrtsdemux:demux', { reason: 'program', generation: 0, pads: 'audio_0_0101' });
        expect(host.log).not.toHaveBeenCalled();
        t.onEvent('mrtsdemux:demux', {
            reason: 'unknown-stream',
            pid: 0x102,
            'stream-type': 0x06,
            generation: 0,
        });
        expect(host.streamWarnings).toHaveBeenLastCalledWith([
            {
                kind: 'demux-unknown-stream',
                text: 'Input enc-a (audio-in): PID 0x0102: stream type 0x06 with no known descriptor is not demuxed',
            },
        ]);
        expect(
            t.onEvent('mrtsdemux:demux', {
                reason: 'program',
                generation: 1,
                'pcr-pid': 257,
                pads: 'audio_1_0101',
            }),
        ).toBe(true);
        expect(host.log).toHaveBeenCalledWith(
            'info',
            { demuxProgram: { name: 'demux', generation: 1, pads: 'audio_1_0101', pcrPid: 257 } },
            'Input enc-a (audio-in): program changed (generation 1)',
        );
        expect(host.streamWarnings).toHaveBeenLastCalledWith([]);
        t.stop(false);
        expect(host.streamWarnings).toHaveBeenLastCalledWith([]);
    });

    it("an ASRC's messages are read and passed on; an engage is logged as part 10 words it", () => {
        const { t, host } = make(
            [A],
            undefined,
            'avdec_aac ! mrasrc name=asrc bypass-below-ppm=0.5 ! fakesink',
        );
        const stats = { mode: 'device', state: 'locked', 'device-ppb': -12_100, 'in-frames': 10 };
        expect(t.onEvent('mrasrc-stats:asrc', stats)).toBe(false);
        expect(
            t.onEvent('mrasrc-event:asrc', {
                kind: 'engaged',
                reason: 'ratio',
                'source-ppb': 3000,
            }),
        ).toBe(false);
        expect(host.log).toHaveBeenCalledWith(
            'info',
            { asrcEvent: { name: 'asrc', kind: 'engaged', reason: 'ratio', 'source-ppb': 3000 } },
            'Source clock +3.0 ppm: resampling',
        );
        t.tick();
        expect(t.summary()).toMatchObject({ clockCorrection: {}, deviceClockPpm: -12.1 });
        expect(t.publication.data.timing).toMatchObject({
            clockCorrection: 'none (house rate)',
            deviceClock: '−12.1 ppm',
        });
        t.onEvent('mrasrc-event:asrc', { kind: 'ratio-out-of-bounds', 'fit-ppb': -1_200_000 });
        expect(host.log).toHaveBeenLastCalledWith(
            'warn',
            expect.objectContaining({
                asrcEvent: expect.objectContaining({ kind: 'ratio-out-of-bounds' }),
            }),
            'mrasrc-event ratio-out-of-bounds',
        );
        expect(host.streamWarnings).toHaveBeenLastCalledWith([
            expect.objectContaining({ kind: 'asrc-out-of-bounds' }),
        ]);
        t.stop(false);
    });
});

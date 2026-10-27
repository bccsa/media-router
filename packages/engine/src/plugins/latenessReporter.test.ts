import { describe, it, expect, vi } from 'vitest';
import { LatenessReporter, parseLatenessPayload } from './latenessReporter.js';

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
const lat = (meanMs: number, minMs: number, maxMs: number) => ({ meanMs, minMs, maxMs });

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
    });

    it('a 3-input muxer names its slowest input and merges nothing across inputs', () => {
        const r = new LatenessReporter({
            inputs: () => [
                { tap: 'lat_busin_0', n: 1, label: 'srt-a (input-0)' },
                { tap: 'lat_busin_1', n: 2, label: 'srt-b (input-1)' },
                { tap: 'lat_busin_2', n: 3, label: 'srt-c (input-2)' },
            ],
        });
        r.onEvent('mrlateness:lat_busin_0', win(20));
        r.onEvent('mrlateness:lat_busin_1', win(140));
        r.onEvent('mrlateness:lat_busin_2', win(65));
        r.onEvent('mrlateness:lat_busout_40010', win(300));
        const s = r.summary();
        expect(s.slowest).toBe('srt-b (input-1)');
        expect(s.inputs.map((i) => i.addedMs)).toEqual([280, 160, 235]);
    });

    it('a dark input keeps every number: inputs A, B, C, then A goes stale, B stays 2', () => {
        const r = new LatenessReporter({
            intervalMs: 2000,
            inputs: () => [
                { tap: 'lat_busin_41000_aaaaaa', n: 1, label: 'A' },
                { tap: 'lat_busin_41001_bbbbbb', n: 2, label: 'B' },
                { tap: 'lat_busin_41002_cccccc', n: 3, label: 'C' },
            ],
        });
        r.onEvent('mrlateness:lat_busin_41000_aaaaaa', win(5), 0);
        r.onEvent('mrlateness:lat_busin_41001_bbbbbb', win(9), 0);
        r.onEvent('mrlateness:lat_busin_41002_cccccc', win(7), 0);
        expect(r.summary(0).inputs.map((i) => [i.n, i.label])).toEqual([
            [1, 'A'],
            [2, 'B'],
            [3, 'C'],
        ]);
        r.onEvent('mrlateness:lat_busin_41001_bbbbbb', win(9), 7000);
        r.onEvent('mrlateness:lat_busin_41002_cccccc', win(7), 7000);
        expect(r.summary(7000).inputs.map((i) => [i.n, i.label])).toEqual([
            [2, 'B'],
            [3, 'C'],
        ]);
    });

    it('a module with one input names its tap whatever it is called; unknown taps come after', () => {
        const one = new LatenessReporter({
            inputs: () => [{ tap: 'lat_busin_41000_abcdef', n: 1, label: 'srt-1 (in)' }],
        });
        one.onEvent('mrlateness:lat_busin', win(5));
        expect(one.summary().inputs).toMatchObject([
            { tap: 'lat_busin', n: 1, label: 'srt-1 (in)' },
        ]);

        const r = new LatenessReporter({
            inputs: () => [
                { tap: 'lat_busin_0', n: 1, label: 'A' },
                { tap: 'lat_busin_1', n: 3, label: 'C' },
            ],
        });
        r.onEvent('mrlateness:lat_busin_1', win(5));
        r.onEvent('mrlateness:lat_busin_9', win(5));
        r.onEvent('mrlateness:lat_busin_7', win(5));
        expect(r.summary().inputs.map((i) => [i.tap, i.n, i.label])).toEqual([
            ['lat_busin_1', 3, 'C'],
            ['lat_busin_7', 4, 'busin_7'],
            ['lat_busin_9', 5, 'busin_9'],
        ]);
    });

    it('asks for the inputs only while an input tap reports', () => {
        const inputs = vi.fn(() => []);
        const r = new LatenessReporter({ inputs });
        r.onEvent('mrlateness:lat_busout_41000', win(12));
        r.summary();
        expect(inputs).not.toHaveBeenCalled();
        r.onEvent('mrlateness:lat_busin', win(5));
        expect(r.summary().inputs).toMatchObject([{ n: 1, label: 'busin' }]);
        expect(inputs).toHaveBeenCalledTimes(1);
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
    });

    it('λ = 150 ms past D renders at 150 + device', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_render', win(150));
        r.setPresentation({ presentationDelayMs: 60, deviceLatencyMs: 100 });
        expect(r.summary().renderMs).toBe(250);
    });

    it('carries the note of a stand-in device latency, and clears it on reset', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_render', win(20));
        r.setPresentation({ deviceLatencyMs: 1000 / 60, deviceLatencyNote: '60 Hz assumed' });
        expect(r.summary().deviceLatencyNote).toBe('60 Hz assumed');
        r.setPresentation({ deviceLatencyMs: 20 });
        expect(r.summary().deviceLatencyNote).toBeUndefined();
        r.setPresentation({ deviceLatencyMs: 1000 / 60, deviceLatencyNote: '60 Hz assumed' });
        r.reset();
        r.onEvent('mrlateness:lat_render', win(20));
        r.setPresentation({ deviceLatencyMs: 20 });
        expect(r.summary().deviceLatencyNote).toBeUndefined();
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

    it('warns once per tap it hides, and again after a reset (B-26)', () => {
        const onHidden = vi.fn();
        const r = new LatenessReporter({ onHidden });
        const off = (meanMs: number) => ({ count: 100, meanMs, minMs: meanMs, maxMs: meanMs });
        r.onEvent('mrlateness:lat_busout_41000', win(12));
        // An egress tap on house time under a 620.8 h base, then an unstamped ingress.
        r.onEvent('mrlateness:lat_busout_41000', win(2_234_996_888));
        r.onEvent('mrlateness:lat_busout_41000', win(2_234_998_890));
        r.onEvent('mrlateness:lat_busin', win(2_108_445_230));
        r.onEvent('mrlateness:lat_busin', win(2_108_447_230));
        expect(onHidden.mock.calls).toEqual([
            ['lat_busout_41000', off(2_234_996_888)],
            ['lat_busin', off(2_108_445_230)],
        ]);
        expect(r.summary()).toMatchObject({ inputs: [] });
        expect(r.summary().output).toBeUndefined();
        // A window on the timeline in between changes nothing: the tap stays warned.
        r.onEvent('mrlateness:lat_busout_41000', win(40));
        expect(r.summary().output?.meanMs).toBe(40);
        r.onEvent('mrlateness:lat_busout_41000', win(2_235_000_890));
        expect(onHidden).toHaveBeenCalledTimes(2);
        // A just-under-1 h window is shown (a box up less than an hour reads minutes).
        r.onEvent('mrlateness:lat_busout_41001', win(3_599_999));
        expect(r.summary().output?.meanMs).toBe(3_599_999);
        expect(onHidden).toHaveBeenCalledTimes(2);
        r.reset();
        r.onEvent('mrlateness:lat_busout_41000', win(2_235_002_890));
        expect(onHidden).toHaveBeenCalledTimes(3);
        expect(onHidden).toHaveBeenLastCalledWith('lat_busout_41000', off(2_235_002_890));
    });

    it('two or more bus outputs: each listed by tap name, and merged as before', () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin', win(100));
        r.onEvent('mrlateness:lat_busout_41001', win(69, 60, 80, 50));
        r.onEvent('mrlateness:lat_busout_41000', win(129, 120, 140));
        const s = r.summary();
        // Count-weighted: (129 × 100 + 69 × 50) / 150.
        expect(s.output).toEqual({ meanMs: 109, minMs: 60, maxMs: 140 });
        expect(s.inputs[0].addedMs).toBe(9);
        expect(s.outputs).toMatchObject([
            { tap: 'lat_busout_41000', port: '41000', lateness: lat(129, 120, 140) },
            { tap: 'lat_busout_41001', port: '41001', lateness: lat(69, 60, 80) },
        ]);
    });

    it("a module's processing latency (OQ-22) rides along, and a reset clears it", () => {
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_busin', win(10));
        r.onEvent('mrlateness:lat_busout_41000', win(30));
        expect(r.summary().processingLatencyMs).toBeUndefined();
        r.setProcessingLatency(5.2);
        const s = r.summary();
        expect(s.processingLatencyMs).toBe(5.2);
        // Measured transit and the lookahead stay apart: the PTS carry the one, not the other.
        expect(s.inputs[0].addedMs).toBe(20);
        r.setProcessingLatency(undefined);
        expect(r.summary().processingLatencyMs).toBeUndefined();
        r.setProcessingLatency(5);
        r.reset();
        expect(r.summary().processingLatencyMs).toBeUndefined();
    });

    it('one bus output, or one left when another goes quiet, is not listed', () => {
        const r = new LatenessReporter({ intervalMs: 2000 });
        r.onEvent('mrlateness:lat_busout_41000', win(88), 0);
        expect(r.summary(0).outputs).toBeUndefined();
        r.onEvent('mrlateness:lat_busout_41001', win(90), 0);
        expect(r.summary(0).outputs).toHaveLength(2);
        r.onEvent('mrlateness:lat_busout_41001', win(90), 7000);
        const s = r.summary(7000);
        expect(s.outputs).toBeUndefined();
        expect(s.output?.meanMs).toBe(90);
    });
});

type AwState = 'waiting' | 'present' | 'absent';
interface AwOpts {
    reason?: string;
    aligner?: string;
    latenessMs?: number;
    paceMs?: number;
    wMs?: number;
    absences?: number;
    staleMs?: number;
    fullCount?: number;
    levelTimeMs?: number;
    levelBytes?: number;
    cueLatenessMs?: number;
    paceTargetMs?: number;
}
/** An `mralignwatch` message payload as the runners forward it (ns fields). */
const aw = (input: string, state: AwState, o: AwOpts = {}) => ({
    reason: o.reason ?? 'interval',
    aligner: o.aligner ?? 'mixin',
    input,
    state,
    lateness: (o.latenessMs ?? 0) * MS,
    pace: (o.paceMs ?? 0) * MS,
    'silence-limit': (o.wMs ?? 100) * MS,
    absences: o.absences ?? 0,
    'stale-buffers': 0,
    'stale-time': (o.staleMs ?? 0) * MS,
    gaps: 0,
    'level-time': (o.levelTimeMs ?? 0) * MS,
    'level-bytes': o.levelBytes ?? 0,
    'full-count': o.fullCount ?? 0,
    ...(o.cueLatenessMs !== undefined
        ? { 'cue-start': 0, 'cue-lateness': o.cueLatenessMs * MS, 'cue-behind': 0 }
        : {}),
    ...(o.paceTargetMs !== undefined ? { 'pace-target': o.paceTargetMs * MS } : {}),
});

/** A mixer's fan-in: watches labelled by connection id, each joining its edge's tap. */
const TAPS: Record<string, string> = { c1: 'lat_busin_1', c2: 'lat_busin_2', c3: 'lat_busin_3' };
const LABELS: Record<string, string> = {
    lat_busin_1: 'enc-a (audio-in)',
    lat_busin_2: 'enc-b (audio-in)',
    lat_busin_3: 'enc-c (audio-in)',
};
const fanIn = () =>
    new LatenessReporter({
        inputs: () => Object.entries(LABELS).map(([tap, label], i) => ({ tap, n: i + 1, label })),
        alignerInput: (w) => (TAPS[w.input] ? { tap: TAPS[w.input] } : { label: w.input }),
    });

describe('LatenessReporter: aligner inputs (WI-P2-13)', () => {
    it('absent → warning naming the input and its W → present clears it', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present', { latenessMs: 40 }), 0);
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'present', { latenessMs: 140 }), 0);
        expect(r.alignerWarnings(0)).toEqual({ absent: null, full: null });

        const gone = aw('c2', 'absent', { reason: 'state', wMs: 312.4, absences: 1 });
        expect(r.onAligner('mralignwatch:mixin_aw_2', gone, 100)).toEqual({
            changed: true,
            events: [],
        });
        expect(r.alignerWarnings(100)).toEqual({
            absent: 'Input enc-b (audio-in) silent for 312 ms — continuing without it',
            full: null,
        });
        expect(r.summary(100).inputs.find((i) => i.tap === 'lat_busin_2')).toMatchObject({
            label: 'enc-b (audio-in)',
            state: 'absent',
            silenceLimitMs: 312.4,
            absences: 1,
        });
        // A report that changes nothing is no change.
        expect(r.onAligner('mralignwatch:mixin_aw_2', gone, 1100)?.changed).toBe(false);

        const back = aw('c2', 'present', { reason: 'state', latenessMs: 140, absences: 1 });
        expect(r.onAligner('mralignwatch:mixin_aw_2', back, 2000)?.changed).toBe(true);
        expect(r.alignerWarnings(2000).absent).toBeNull();
        expect(r.summary(2000).inputs.map((i) => i.state)).toEqual(['present', 'present']);
    });

    it('one warning names every absent input; it clears only when all are back', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'absent', { wMs: 100 }), 0);
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'present'), 0);
        r.onEvent('mralignwatch:mixin_aw_3', aw('c3', 'absent', { wMs: 2000 }), 0);
        expect(r.alignerWarnings(0).absent).toBe(
            'Input enc-a (audio-in) silent for 100 ms — continuing without it; ' +
                'Input enc-c (audio-in) silent for 2000 ms — continuing without it',
        );
        expect(r.summary(0).waitingFor).toBe('enc-a (audio-in), enc-c (audio-in)');
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present'), 10);
        expect(r.alignerWarnings(10).absent).toBe(
            'Input enc-c (audio-in) silent for 2000 ms — continuing without it',
        );
        r.onEvent('mralignwatch:mixin_aw_3', aw('c3', 'present'), 20);
        expect(r.alignerWarnings(20).absent).toBeNull();
    });

    it('waiting for: the absent input, else the slowest input of the aligner that adds most', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present', { latenessMs: 20, paceMs: 140 }));
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'present', { latenessMs: 140, paceMs: 140 }));
        r.onEvent('mralignwatch:mixin_aw_3', aw('c3', 'present', { latenessMs: 65, paceMs: 140 }));
        let s = r.summary();
        expect(s.waitingFor).toBe('enc-b (audio-in)');
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'absent', { latenessMs: 20, paceMs: 140 }));
        s = r.summary();
        expect(s.waitingFor).toBe('enc-a (audio-in)');
        // One present input is waited for by nobody.
        const one = fanIn();
        one.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present', { latenessMs: 20 }));
        expect(one.summary().waitingFor).toBeUndefined();
    });

    it('pace: what the aligner adds to its fastest present input; the most of several', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present', { latenessMs: 100, paceMs: 300 }));
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'present', { latenessMs: 250, paceMs: 300 }));
        // An absent or waiting input is nobody's fastest.
        r.onEvent('mralignwatch:mixin_aw_3', aw('c3', 'absent', { latenessMs: 5, paceMs: 300 }));
        r.onEvent('mralignwatch:mixin_aw_9', aw('c9', 'waiting', { latenessMs: 0, paceMs: 300 }));
        expect(r.summary().paceMs).toBe(200);
        // A second aligner adding more is the module's pace, and the one it waits on.
        const two = fanIn();
        const o = { aligner: 'omix0' };
        two.onEvent(
            'mralignwatch:mixin_aw_1',
            aw('c1', 'present', { latenessMs: 100, paceMs: 300 }),
        );
        two.onEvent(
            'mralignwatch:mixin_aw_2',
            aw('c2', 'present', { latenessMs: 250, paceMs: 300 }),
        );
        two.onEvent(
            'mralignwatch:o_aw_1',
            aw('in1', 'present', { ...o, latenessMs: 10, paceMs: 700 }),
        );
        two.onEvent(
            'mralignwatch:o_aw_2',
            aw('in2', 'present', { ...o, latenessMs: 690, paceMs: 700 }),
        );
        expect(two.summary()).toMatchObject({ paceMs: 690, waitingFor: 'in2' });
        // Inputs later than the pace are released on arrival: nothing added.
        const late = fanIn();
        late.onEvent(
            'mralignwatch:mixin_aw_1',
            aw('c1', 'present', { latenessMs: 320, paceMs: 300 }),
        );
        expect(late.summary().paceMs).toBe(0);
    });

    it('a rejoin: one event naming the input, its absence and the stale ms once settled', () => {
        const r = fanIn();
        const ch = 'mralignwatch:mixin_aw_2';
        r.onEvent(ch, aw('c2', 'present', { staleMs: 30 }), 0);
        expect(
            r.onAligner(ch, aw('c2', 'absent', { staleMs: 30, absences: 1 }), 1000)?.events,
        ).toEqual([]);
        r.onEvent(ch, aw('c2', 'absent', { staleMs: 30, absences: 1 }), 2000);
        // The return counts its first stale buffer; the rest of the backlog comes after.
        expect(
            r.onAligner(ch, aw('c2', 'present', { staleMs: 40, absences: 1 }), 4000)?.events,
        ).toEqual([]);
        expect(
            r.onAligner(ch, aw('c2', 'present', { staleMs: 1020, absences: 1 }), 5000)?.events,
        ).toEqual([]);
        const settled = r.onAligner(ch, aw('c2', 'present', { staleMs: 1020, absences: 1 }), 6000);
        expect(settled?.events).toEqual([
            {
                kind: 'rejoin',
                watch: { name: 'mixin_aw_2', aligner: 'mixin', input: 'c2' },
                label: 'enc-b (audio-in)',
                absentMs: 3000,
                discardedMs: 990,
            },
        ]);
        expect(r.summary(6000).inputs.find((i) => i.tap === 'lat_busin_2')?.staleMs).toBe(1020);
        // Once: the next report finds nothing pending.
        expect(
            r.onAligner(ch, aw('c2', 'present', { staleMs: 1020, absences: 1 }), 7000)?.events,
        ).toEqual([]);
    });

    it('a return with no discard says how long it was absent; a late joiner trims no rejoin', () => {
        const r = fanIn();
        const ch = 'mralignwatch:mixin_aw_1';
        r.onEvent(ch, aw('c1', 'absent', { absences: 1 }), 0);
        r.onEvent(ch, aw('c1', 'present', { absences: 1 }), 500);
        expect(r.onAligner(ch, aw('c1', 'present', { absences: 1 }), 1500)?.events).toMatchObject([
            { kind: 'rejoin', absentMs: 500, discardedMs: 0 },
        ]);
        // waiting → present with stale: a join trim, not a rejoin (WI-P2-9).
        const j = 'mralignwatch:mixin_aw_3';
        r.onEvent(j, aw('c3', 'waiting'), 0);
        expect(r.onAligner(j, aw('c3', 'present', { staleMs: 290 }), 100)?.events).toEqual([]);
        expect(r.onAligner(j, aw('c3', 'present', { staleMs: 290 }), 1100)?.events).toEqual([]);
        // Gone again before the discard settled: the event comes with the new absence.
        r.onEvent(ch, aw('c1', 'absent', { absences: 2 }), 2000);
        r.onEvent(ch, aw('c1', 'present', { staleMs: 70, absences: 2 }), 2600);
        expect(
            r.onAligner(ch, aw('c1', 'absent', { staleMs: 80, absences: 3 }), 2700)?.events,
        ).toMatchObject([{ kind: 'rejoin', absentMs: 600, discardedMs: 80 }]);
    });

    it('a flush makes an absent input wait again: no rejoin when it delivers', () => {
        const r = fanIn();
        const ch = 'mralignwatch:mixin_aw_1';
        r.onEvent(ch, aw('c1', 'absent', { absences: 1 }), 0);
        r.onEvent(ch, aw('c1', 'waiting', { absences: 1 }), 1000);
        expect(r.onAligner(ch, aw('c1', 'present', { absences: 1 }), 2000)?.events).toEqual([]);
        expect(r.onAligner(ch, aw('c1', 'present', { absences: 1 }), 3000)?.events).toEqual([]);
    });

    it('a new element under an old name (a runner respawn) is no rejoin', () => {
        const r = fanIn();
        const ch = 'mralignwatch:mixin_aw_1';
        r.onEvent(ch, aw('c1', 'absent', { absences: 2, staleMs: 400 }), 0);
        r.onEvent(ch, aw('c1', 'present'), 1000);
        expect(r.onAligner(ch, aw('c1', 'present'), 2000)?.events).toEqual([]);
        expect(r.alignerWarnings(2000).absent).toBeNull();
    });

    it('a full queue: the warning names the input until it drained to half', () => {
        const r = fanIn();
        const ch = 'mralignwatch:mixin_aw_1';
        r.onEvent(ch, aw('c1', 'present', { levelTimeMs: 900, levelBytes: 900 }), 0);
        const full = aw('c1', 'present', {
            reason: 'full',
            fullCount: 1,
            levelTimeMs: 5000,
            levelBytes: 4000,
        });
        expect(r.onAligner(ch, full, 100)?.changed).toBe(true);
        expect(r.alignerWarnings(100).full).toBe(
            'Input enc-a (audio-in) queue full — upstream held',
        );
        const level = (t: number, b: number) =>
            aw('c1', 'present', { fullCount: 1, levelTimeMs: t, levelBytes: b });
        expect(r.onAligner(ch, level(4000, 3200), 1100)?.changed).toBe(false);
        expect(r.alignerWarnings(1100).full).not.toBeNull();
        // Time at half, bytes not yet: still the same episode.
        r.onEvent(ch, level(2500, 2100), 2100);
        expect(r.alignerWarnings(2100).full).not.toBeNull();
        expect(r.onAligner(ch, level(2400, 1900), 3100)?.changed).toBe(true);
        expect(r.alignerWarnings(3100).full).toBeNull();
        // A rise in full-count is an episode too, a missed `full` message or not.
        r.onEvent(ch, level(5000, 4000), 4100);
        r.onEvent(
            ch,
            aw('c1', 'present', { fullCount: 2, levelTimeMs: 5000, levelBytes: 4000 }),
            5100,
        );
        expect(r.alignerWarnings(5100).full).not.toBeNull();
    });

    it('a dark input keeps its row after its tap goes quiet; one with no tap has its own', () => {
        const r = fanIn();
        r.onEvent('mrlateness:lat_busin_1', win(12), 0);
        r.onEvent('mrlateness:lat_busin_2', win(30), 0);
        r.onEvent('mrlateness:lat_busout_41000', win(60), 0);
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present'), 0);
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'absent', { absences: 1 }), 0);
        r.onEvent(
            'mralignwatch:aw_demux_0_klv',
            aw('demux_0_klv', 'waiting', { aligner: 'mux' }),
            0,
        );
        let s = r.summary(0);
        expect(s.inputs.map((i) => [i.tap, i.label, i.state, i.lateness?.meanMs])).toEqual([
            ['lat_busin_1', 'enc-a (audio-in)', 'present', 12],
            ['lat_busin_2', 'enc-b (audio-in)', 'absent', 30],
            ['mralignwatch:demux_0_klv', 'demux_0_klv', 'waiting', undefined],
        ]);
        expect(s.inputs[2].addedMs).toBeUndefined();
        // 7 s on the taps are quiet, the watches still report: the absent row stays.
        r.onEvent('mrlateness:lat_busin_1', win(12), 7000);
        r.onEvent('mrlateness:lat_busout_41000', win(60), 7000);
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present'), 7000);
        r.onEvent('mralignwatch:mixin_aw_2', aw('c2', 'absent', { absences: 1 }), 7000);
        s = r.summary(7000);
        expect(s.inputs.map((i) => [i.tap, i.state, i.lateness?.meanMs])).toEqual([
            ['lat_busin_1', 'present', 12],
            ['lat_busin_2', 'absent', undefined],
        ]);
        // P0's slowest input is read off the taps, and only with two or more.
        expect(s.slowest).toBeUndefined();
    });

    it('watches on one input merge: absent if any is, the least W, the most absences', () => {
        const r = new LatenessReporter({
            alignerInput: (w) => ({ label: w.input.replace(/_(video|audio)$/, '') }),
        });
        const m = { aligner: 'mux' };
        r.onEvent(
            'mralignwatch:aw_v',
            aw('demux_0_video', 'present', { ...m, wMs: 120, absences: 2 }),
        );
        r.onEvent(
            'mralignwatch:aw_a',
            aw('demux_0_audio', 'absent', { ...m, wMs: 300, absences: 3, staleMs: 40 }),
        );
        const [only] = r.summary().inputs;
        expect(only).toEqual({
            tap: 'mralignwatch:demux_0',
            n: 1,
            label: 'demux_0',
            state: 'absent',
            silenceLimitMs: 120,
            absences: 3,
            staleMs: 40,
        });
        // The warning gives the W of the watch that went absent.
        expect(r.alignerWarnings().absent).toBe(
            'Input demux_0 silent for 300 ms — continuing without it',
        );
    });

    it('internal stages (null) count to the pace and a full queue, never named as inputs', () => {
        const r = new LatenessReporter({
            alignerInput: (w) => (w.aligner === 'omix0' ? null : { label: w.input }),
        });
        const o = { aligner: 'omix0', paceMs: 500 };
        r.onEvent('mralignwatch:o_aw1', aw('in1', 'present', { ...o, latenessMs: 100 }));
        r.onEvent('mralignwatch:o_aw2', aw('in2', 'absent', { ...o, latenessMs: 490 }));
        r.onEvent(
            'mralignwatch:o_aw3',
            aw('in3', 'present', {
                ...o,
                latenessMs: 450,
                reason: 'full',
                fullCount: 1,
                levelTimeMs: 5000,
            }),
        );
        const s = r.summary();
        expect(s.inputs).toEqual([]);
        expect(s.paceMs).toBe(400);
        expect(s.waitingFor).toBeUndefined();
        expect(r.alignerWarnings()).toEqual({
            absent: null,
            full: 'Input in3 queue full — upstream held',
        });
    });

    it('a late cue is an event with the pace it raised', () => {
        const r = fanIn();
        const k = { aligner: 'mux' };
        r.onEvent('mralignwatch:aw_v', aw('demux_0_video', 'present', { ...k, paceMs: 120 }));
        const cue = aw('demux_1_klv', 'present', {
            ...k,
            reason: 'late-cue',
            paceMs: 800,
            cueLatenessMs: 800,
        });
        expect(r.onAligner('mralignwatch:aw_k', cue)?.events).toEqual([
            {
                kind: 'late-cue',
                watch: { name: 'aw_k', aligner: 'mux', input: 'demux_1_klv' },
                label: 'demux_1_klv',
                cueLatenessMs: 800,
                raisedMs: 680,
            },
        ]);
    });

    it('a late cue under a slewing pace: the raise is read off the targets (B-80)', () => {
        const r = fanIn();
        const k = { aligner: 'mux' };
        r.onEvent(
            'mralignwatch:aw_v',
            aw('demux_0_video', 'present', { ...k, paceMs: 120, paceTargetMs: 120 }),
        );
        const cue = aw('demux_1_klv', 'present', {
            ...k,
            reason: 'late-cue',
            paceMs: 121,
            paceTargetMs: 800,
            cueLatenessMs: 800,
        });
        expect(r.onAligner('mralignwatch:aw_k', cue)?.events).toMatchObject([
            { kind: 'late-cue', cueLatenessMs: 800, raisedMs: 680 },
        ]);
        expect(r.summary().paceMs).toBe(121);
    });

    it('a pace fall is one event from the member that applied it (B-82)', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'present', { paceMs: 300 }));
        const fell = {
            ...aw('c2', 'present', { reason: 'pace-fell', paceMs: 20, paceTargetMs: 20 }),
            fell: 280 * MS,
            'fall-after': 180_000 * MS,
        };
        expect(r.onAligner('mralignwatch:mixin_aw_2', fell)?.events).toEqual([
            {
                kind: 'pace-fell',
                watch: { name: 'mixin_aw_2', aligner: 'mixin', input: 'c2' },
                label: 'enc-b (audio-in)',
                fellMs: 280,
                fallAfterMs: 180_000,
            },
        ]);
        // The next interval report carries the fallen pace and no event.
        const next = aw('c2', 'present', { paceMs: 20, paceTargetMs: 20 });
        expect(r.onAligner('mralignwatch:mixin_aw_2', next)?.events).toEqual([]);
    });

    it('a watch that stopped reporting goes (input removed), and with it its warning', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'absent', { absences: 1 }), 0);
        expect(r.alignerWarnings(6000).absent).not.toBeNull();
        expect(r.alignerWarnings(6001).absent).toBeNull();
        expect(r.summary(6001).inputs).toEqual([]);
        // Unknown payloads are taken and ignored; other channels are not taken.
        expect(r.onEvent('mralignwatch:x', { state: 'lost' })).toBe(true);
        expect(r.onAligner('mrlateness:lat_busin', win(5))).toBeNull();
        expect(r.summary().inputs).toEqual([]);
    });

    it('a reset forgets the watches', () => {
        const r = fanIn();
        r.onEvent('mralignwatch:mixin_aw_1', aw('c1', 'absent'));
        r.reset();
        expect(r.alignerWarnings()).toEqual({ absent: null, full: null });
        expect(r.summary().inputs).toEqual([]);
    });
});

describe('LatenessReporter: demuxes and consumer ASRCs (WI-P3-6)', () => {
    const iv = (pes: number, o: Record<string, unknown> = {}) => ({
        reason: 'interval',
        select: '',
        stream: 'found',
        pes,
        gaps: 1,
        'cc-lost': 4,
        generation: 0,
        ...o,
    });
    const st = (mode: string, o: Record<string, number> = {}) => ({
        state: 'locked',
        mode,
        relocks: 0,
        'in-frames': 1000,
        'source-ppb': 0,
        'device-ppb': 0,
        ...o,
    });
    /** Two reports a second apart: the demux row shows from the second. */
    const feed = (r: LatenessReporter, name: string, at = 0, o: Record<string, unknown> = {}) => {
        r.onEvent(`mrtsdemux:${name}`, iv(0, o), at);
        r.onEvent(`mrtsdemux:${name}`, iv(47, o), at + 1000);
    };

    it("a single-input module: the demux joins its one input's row, whatever the tap is called", () => {
        const r = new LatenessReporter({
            inputs: () => [{ tap: 'lat_busin_41000_aa11bb', n: 1, label: 'srt-1 (mpegts-in)' }],
        });
        r.onEvent('mrlateness:lat_busin', win(30), 1000);
        feed(r, 'demux');
        const s = r.summary(1000);
        expect(s.inputs).toHaveLength(1);
        expect(s.inputs[0]).toMatchObject({
            tap: 'lat_busin',
            n: 1,
            label: 'srt-1 (mpegts-in)',
            lateness: lat(30, 30, 30),
            demux: { pesPerS: 47, gaps: 1, ccLost: 4, unknownStreams: 0 },
        });
        // Its tap quiet (no instrument): the demux keeps the input's row.
        const dark = new LatenessReporter({
            inputs: () => [{ tap: 'lat_busin_41000_aa11bb', n: 1, label: 'srt-1 (mpegts-in)' }],
        });
        feed(dark, 'demux');
        expect(dark.summary(1000).inputs.map((i) => [i.tap, i.label])).toEqual([
            ['lat_busin_41000_aa11bb', 'srt-1 (mpegts-in)'],
        ]);
    });

    it("several inputs: the module's answer places a demux, one it does not place has its own row", () => {
        const r = new LatenessReporter({
            inputs: () => [
                { tap: 'lat_busin_0', n: 1, label: 'srt-a (input-0)' },
                { tap: 'lat_busin_1', n: 2, label: 'srt-b (input-1)' },
            ],
            branchInput: (el) => (el === 'demux_1' ? { tap: 'lat_busin_1' } : undefined),
        });
        r.onEvent('mrlateness:lat_busin_0', win(20), 1000);
        r.onEvent('mrlateness:lat_busin_1', win(40), 1000);
        feed(r, 'demux_1');
        feed(r, 'probe_demux');
        const rows = r.summary(1000).inputs.map((i) => [i.n, i.label, i.demux?.pesPerS]);
        expect(rows).toEqual([
            [1, 'srt-a (input-0)', undefined],
            [2, 'srt-b (input-1)', 47],
            [3, 'probe_demux', 47],
        ]);
        // null: no row; its warning names it.
        const internal = new LatenessReporter({ branchInput: () => null });
        feed(internal, 'dm');
        internal.onEvent(
            'mrtsdemux:dm',
            { reason: 'no-stream', select: 'audio/mpeg', stream: 'missing' },
            1500,
        );
        expect(internal.summary(1500).inputs).toEqual([]);
        expect(internal.streamWarnings(1500)).toEqual([
            { kind: 'input-no-stream', text: 'Input dm carries no audio stream' },
        ]);
    });

    it('a branch ASRC on its input row; the module own ASRC and the device clock on the module', () => {
        const r = new LatenessReporter({
            inputs: () => [
                { tap: 'lat_busin_a', n: 1, label: 'enc-a (audio-in)' },
                { tap: 'lat_busin_b', n: 2, label: 'enc-b (audio-in)' },
            ],
            branchInput: (el) =>
                el === 'mixin_asrc_a'
                    ? { tap: 'lat_busin_a' }
                    : el === 'gone'
                      ? { tap: 'x' }
                      : undefined,
        });
        r.onEvent('mrlateness:lat_busin_a', win(20), 1000);
        r.onEvent('mrlateness:lat_busin_b', win(20), 1000);
        r.onEvent('mrasrc-stats:mixin_asrc_a', st('decode', { 'source-ppb': 23_400 }), 1000);
        r.onEvent('mrasrc-stats:gone', st('bypass'), 1000);
        r.onEvent('mrasrc-stats:outasrc', st('device', { 'device-ppb': -12_100 }), 1000);
        const s = r.summary(1000);
        expect(s.inputs.map((i) => i.clockCorrection)).toEqual([{ sourcePpm: 23.4 }, undefined]);
        // An ASRC whose row is not on display shows on the module's.
        expect(s.clockCorrection).toEqual({});
        expect(s.deviceClockPpm).toBe(-12.1);
        // A capture ASRC shows nowhere (its ingest card's).
        const ingest = new LatenessReporter();
        ingest.configure('pulsesrc ! mrasrc name=asrc out-rate=48000 ! fakesink');
        expect(ingest.onEvent('mrasrc-stats:asrc', st('capture'), 0)).toBe(false);
        expect(ingest.summary(0)).toEqual({ inputs: [], instrument: true });
    });

    it('the warnings name their inputs, in their order; each goes with its condition', () => {
        const r = new LatenessReporter({
            inputs: () => [
                { tap: 'lat_busin_0', n: 1, label: 'srt-a (input-0)' },
                { tap: 'lat_busin_1', n: 2, label: 'srt-b (input-1)' },
            ],
            branchInput: (el) => ({ tap: `lat_busin_${el.slice(-1)}` }),
        });
        r.configure('unixfdsrc ! mrtsdemux name=demux_1 media=audio ! fakesink');
        r.onEvent('mrlateness:lat_busin_0', win(20), 0);
        r.onEvent('mrlateness:lat_busin_1', win(20), 0);
        r.onEvent('mrtsdemux:demux_1', { reason: 'no-stream', stream: 'missing' }, 0);
        r.onEvent(
            'mrtsdemux:demux_0',
            { reason: 'program', generation: 0, pads: 'video_0_0100' },
            0,
        );
        r.onEvent(
            'mrtsdemux:demux_0',
            { reason: 'not-house-time', pid: 256, 'offset-ms': 7_200_000 },
            0,
        );
        expect(r.streamWarnings(0)).toEqual([
            {
                kind: 'input-not-house-time',
                text: 'Input srt-a (input-0) is 7200 s off house time — its producer does not stamp house time',
            },
            { kind: 'input-no-stream', text: 'Input srt-b (input-1) carries no audio stream' },
        ]);
        const next = r.onStream(
            'mrtsdemux:demux_0',
            { reason: 'program', generation: 1, pads: 'video_1_0100' },
            1,
        );
        expect(next).toEqual({
            changed: true,
            events: [
                {
                    source: 'demux',
                    label: 'srt-a (input-0)',
                    program: { name: 'demux_0', generation: 1, pads: 'video_1_0100', pcrPid: 0 },
                },
            ],
        });
        r.onEvent('mrtsdemux:demux_1', iv(5), 2);
        expect(r.streamWarnings(2)).toEqual([]);
        r.onEvent('mrasrc-stats:asrc_1', st('decode', { 'source-ppb': 1_300_000 }), 3);
        r.onEvent('mrasrc-event:asrc_1', { kind: 'ratio-out-of-bounds', 'fit-ppb': -1_298_312 }, 3);
        expect(r.streamWarnings(3)).toEqual([
            {
                kind: 'asrc-out-of-bounds',
                text:
                    "Input srt-b (input-1): source clock +1300.0 ppm off house time, past the ASRC's 1000 ppm" +
                    " — check the source's sample rate",
            },
        ]);
    });

    it('a demux that stopped reporting goes with its row and warnings; a reset forgets all', () => {
        const r = new LatenessReporter();
        feed(r, 'demux');
        r.onEvent(
            'mrtsdemux:demux',
            { reason: 'unknown-stream', pid: 0x101, 'stream-type': 6, generation: 0 },
            1000,
        );
        expect(r.summary(1000).inputs[0].demux!.unknownStreams).toBe(1);
        expect(r.streamWarnings(7000)).toHaveLength(1);
        expect(r.streamWarnings(7001)).toEqual([]);
        expect(r.summary(7001).inputs).toEqual([]);
        feed(r, 'demux', 8000);
        r.onEvent('mrasrc-stats:asrc', st('bypass'), 8000);
        r.configure('mrtsdemux name=demux media=video');
        r.reset();
        expect(r.summary(9000)).toEqual({ inputs: [], instrument: true });
        r.onEvent('mrtsdemux:demux', { reason: 'no-stream', stream: 'missing' }, 9000);
        expect(r.streamWarnings(9000)[0].text).toBe('Input demux carries no stream');
    });
});

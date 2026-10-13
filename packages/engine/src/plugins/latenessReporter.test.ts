import { describe, it, expect } from 'vitest';
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
        const r = new LatenessReporter({ labelFor: (t) => t.replace('lat_', '') });
        r.onEvent('mrlateness:lat_busin_0', win(20));
        r.onEvent('mrlateness:lat_busin_1', win(140));
        r.onEvent('mrlateness:lat_busin_2', win(65));
        r.onEvent('mrlateness:lat_busout_40010', win(300));
        const s = r.summary();
        expect(s.slowest).toBe('busin_1');
        expect(s.inputs.map((i) => i.addedMs)).toEqual([280, 160, 235]);
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

import { describe, it, expect } from 'vitest';
import {
    AlignerWatches,
    parseAlignerPayload,
    reanchorEventText,
    reanchorText,
} from './alignerWatches.js';

const MS = 1_000_000;
const payload = (o: Record<string, unknown> = {}) => ({
    reason: 'interval',
    aligner: 'mixin',
    input: 'c1',
    state: 'present',
    lateness: 12 * MS,
    pace: 150 * MS,
    'silence-limit': 100 * MS,
    absences: 0,
    'stale-time': 0,
    'full-count': 0,
    'level-time': 0,
    'level-bytes': 0,
    ...o,
});

describe('parseAlignerPayload: the slew and the fall (B-80, B-82)', () => {
    it('reads pace-target as paceTargetMs while the pace slews; absent when not sent', () => {
        expect(parseAlignerPayload(payload({ 'pace-target': 300 * MS }))).toMatchObject({
            paceMs: 150,
            paceTargetMs: 300,
        });
        expect(parseAlignerPayload(payload())?.paceTargetMs).toBeUndefined();
    });

    it('reads a pace-fell report: the fall and the window, nothing for other reasons', () => {
        const fell = payload({ reason: 'pace-fell', fell: 280 * MS, 'fall-after': 180_000 * MS });
        expect(parseAlignerPayload(fell)).toMatchObject({ fellMs: 280, fallAfterMs: 180_000 });
        expect(parseAlignerPayload(payload({ fell: 280 * MS }))?.fellMs).toBeUndefined();
    });

    it('a pace-fell report is one event; the interval after it none', () => {
        const w = new AlignerWatches();
        const fell = payload({ reason: 'pace-fell', fell: 1000 * MS, 'fall-after': 4000 * MS });
        expect(w.take('mixin_aw_1', fell, 0)?.events).toEqual([
            {
                kind: 'pace-fell',
                watch: { name: 'mixin_aw_1', aligner: 'mixin', input: 'c1' },
                fellMs: 1000,
                fallAfterMs: 4000,
            },
        ]);
        expect(w.take('mixin_aw_1', payload(), 1000)?.events).toEqual([]);
    });
});

describe('re-anchored past the pace ceiling (B-205)', () => {
    it('reads anchor, anchor-was and pace-ceiling; absent when not sent', () => {
        const r = parseAlignerPayload(
            payload({
                reason: 'reanchored',
                anchor: 157_124 * MS,
                'anchor-was': 0,
                'pace-ceiling': 4000 * MS,
            }),
        );
        expect(r).toMatchObject({
            state: 'present',
            anchorMs: 157_124,
            anchorWasMs: 0,
            paceCeilingMs: 4000,
        });
        expect(parseAlignerPayload(payload())?.anchorMs).toBeUndefined();
        expect(parseAlignerPayload(payload({ anchor: -8000 * MS }))?.anchorMs).toBe(-8000);
    });

    it('a reanchored report is one event with its anchor, the one before and the ceiling; a move is a change', () => {
        const w = new AlignerWatches();
        const base = { input: 'audio-1', aligner: 'mux', 'pace-ceiling': 4000 * MS };
        expect(w.take('aw_257', payload({ ...base, anchor: 0 }), 0)?.changed).toBe(true);
        const moved = payload({
            ...base,
            reason: 'reanchored',
            anchor: 157_124 * MS,
            'anchor-was': 0,
        });
        expect(w.take('aw_257', moved, 100)).toEqual({
            changed: true,
            events: [
                {
                    kind: 'reanchored',
                    watch: { name: 'aw_257', aligner: 'mux', input: 'audio-1' },
                    anchorMs: 157_124,
                    wasMs: 0,
                    ceilingMs: 4000,
                },
            ],
        });
        const again = payload({ ...base, anchor: 157_124 * MS });
        expect(w.take('aw_257', again, 1100)).toEqual({ changed: false, events: [] });
        const cleared = payload({
            ...base,
            reason: 'reanchored',
            anchor: 0,
            'anchor-was': 157_124 * MS,
        });
        expect(w.take('aw_257', cleared, 2100)).toMatchObject({
            changed: true,
            events: [{ kind: 'reanchored', anchorMs: 0, wasMs: 157_124 }],
        });
    });

    it('says by how much and which way, hours too; its clear and a move within its episode', () => {
        expect(reanchorText('vv-en (audio-1)', 157_124, 4000)).toBe(
            'Input vv-en (audio-1) re-anchored by +2 min 37 s (late) — past the 4 s pace ceiling',
        );
        expect(reanchorText('a', -8_000, 4000)).toBe(
            'Input a re-anchored by -8.0 s (ahead) — past the 4 s pace ceiling',
        );
        expect(reanchorText('a', 22 * 3_600_000, 4000)).toBe(
            'Input a re-anchored by +22 h 0 min (late) — past the 4 s pace ceiling',
        );
        expect(reanchorEventText('a', 157_124, 0, 4000)).toBe(reanchorText('a', 157_124, 4000));
        expect(reanchorEventText('a', 0, 157_124, 4000)).toBe(
            'Input a back on the house clock: its re-anchor by +2 min 37 s (late) cleared',
        );
        expect(reanchorEventText('a', 300_000, 157_124, 4000)).toBe(
            'Input a re-anchored by +5 min 0 s (late) — past the 4 s pace ceiling (was +2 min 37 s (late))',
        );
    });
});

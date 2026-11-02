import { describe, it, expect } from 'vitest';
import { AlignerWatches, beyondText, parseAlignerPayload } from './alignerWatches.js';

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

describe('past the pace ceiling (B-204)', () => {
    it('reads beyond and pace-ceiling; absent when not sent', () => {
        const r = parseAlignerPayload(
            payload({ state: 'absent', beyond: true, 'pace-ceiling': 4000 * MS }),
        );
        expect(r).toMatchObject({ state: 'absent', beyond: true, paceCeilingMs: 4000 });
        expect(parseAlignerPayload(payload())?.beyond).toBeUndefined();
        expect(parseAlignerPayload(payload({ beyond: false }))?.beyond).toBe(false);
    });

    it('a beyond report is one event with its lateness and the ceiling; the interval after none', () => {
        const w = new AlignerWatches();
        const out = payload({
            reason: 'beyond',
            input: 'audio-1',
            aligner: 'mux',
            state: 'absent',
            lateness: 157_124 * MS,
            beyond: true,
            'pace-ceiling': 4000 * MS,
        });
        expect(w.take('aw_257', out, 0)?.events).toEqual([
            {
                kind: 'beyond',
                watch: { name: 'aw_257', aligner: 'mux', input: 'audio-1' },
                latenessMs: 157_124,
                ceilingMs: 4000,
            },
        ]);
        const again = { ...out, reason: 'interval' };
        expect(w.take('aw_257', again, 1000)?.events).toEqual([]);
    });

    it('says how far: minutes and seconds, 1 h or more (clamped), or ahead of the clock', () => {
        expect(beyondText('vv-en (audio-1)', 157_124, 4000)).toBe(
            'Input vv-en (audio-1) 2 min 37 s late, past the 4 s pace ceiling — continuing without it',
        );
        expect(beyondText('a', 4_100, 4000)).toBe(
            'Input a 4.1 s late, past the 4 s pace ceiling — continuing without it',
        );
        expect(beyondText('a', 3_600_000, 4000)).toBe(
            'Input a 1 h or more late, past the 4 s pace ceiling — continuing without it',
        );
        expect(beyondText('a', -3_600_000, 4000)).toBe(
            'Input a 1 h or more ahead of the house clock — continuing without it',
        );
    });
});

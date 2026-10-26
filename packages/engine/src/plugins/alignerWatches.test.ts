import { describe, it, expect } from 'vitest';
import { AlignerWatches, parseAlignerPayload } from './alignerWatches.js';

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

import { describe, it, expect } from 'vitest';
import { catchUpText, readCatchUp } from './catchUp.js';

/** B-206: the runner's `catch_up` report, and its one INFO line. */
describe('catch_up', () => {
    it('reads the inputs a launch skipped; anything malformed is dropped, nothing is null', () => {
        expect(
            readCatchUp({
                inputs: [
                    { element: 'mixin_aw_0d233b', skippedMs: 5220, buffers: 502 },
                    { element: 7, skippedMs: 3 },
                    { element: 'mixin_aw_507bff', skippedMs: 'lots' },
                ],
                skippedMs: 5220,
            }),
        ).toEqual([{ element: 'mixin_aw_0d233b', skippedMs: 5220, buffers: 502 }]);
        expect(readCatchUp({ inputs: [] })).toBeNull();
        expect(readCatchUp({})).toBeNull();
        expect(readCatchUp(null)).toBeNull();
    });

    it('says how much of each input it skipped, longest first, in one line', () => {
        expect(
            catchUpText([
                { label: 'SRT transcoder', skippedMs: 234.7 },
                { label: 'Mixer', skippedMs: 5220 },
            ]),
        ).toBe(
            'Caught up at the start: skipped 5.2 s of Mixer, 235 ms of SRT transcoder from ' +
                'before it played, never played late',
        );
    });
});

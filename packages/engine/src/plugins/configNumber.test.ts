import { describe, expect, it } from 'vitest';

import { readClampedNumber } from './configNumber';

describe('readClampedNumber', () => {
    it('blank or non-numeric is undefined', () => {
        for (const v of [undefined, null, '', 'abc', NaN, {}]) {
            expect(readClampedNumber(v, 0, 10)).toBeUndefined();
        }
    });
    it('clamps, rounds only when asked, and reads numeric strings', () => {
        expect(readClampedNumber(0.05, 0.1, 2)).toBe(0.1);
        expect(readClampedNumber('0.45', 0.1, 2)).toBe(0.45);
        expect(readClampedNumber(9, 0.1, 2)).toBe(2);
        expect(readClampedNumber(24.6, 1, 51, true)).toBe(25);
        expect(readClampedNumber(-4, 0, 100, true)).toBe(0);
    });
});

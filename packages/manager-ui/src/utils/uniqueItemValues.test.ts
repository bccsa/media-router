import { describe, it, expect } from 'vitest';
import { fillAutoAssigned, nextFreeValue, uniqueValueError } from './uniqueItemValues';

describe('nextFreeValue', () => {
    const auto = { start: 256, step: 8 };

    it('returns the lowest free grid value', () => {
        expect(nextFreeValue([], auto)).toBe(256);
        expect(nextFreeValue([256, 272], auto)).toBe(264);
    });

    it('skips reserved values and ignores off-grid / non-number siblings', () => {
        const taken = Array.from({ length: 30 }, (_, k) => 256 + k * 8); // 256..488
        expect(nextFreeValue(taken, auto, [496])).toBe(504);
        expect(nextFreeValue([300, undefined, ''], auto)).toBe(256);
    });

    it('returns undefined when the grid is exhausted below max', () => {
        expect(nextFreeValue([256, 264], auto, [], 264)).toBeUndefined();
    });
});

describe('uniqueValueError', () => {
    const opts = { unique: true, reserved: [496] };

    it('flags a value another item already holds, naming that item', () => {
        expect(uniqueValueError('PID', 256, 1, [256, 264], opts)).toBe(
            'PID 256 is already used by Item 1',
        );
    });

    it('allows the item keeping its own value, and blanks', () => {
        expect(uniqueValueError('PID', 264, 1, [256, 264], opts)).toBeUndefined();
        expect(uniqueValueError('PID', '', 1, [256, ''], opts)).toBeUndefined();
    });

    it('flags reserved values even without x-unique', () => {
        expect(uniqueValueError('PID', 496, 0, [496], { reserved: [496] })).toBe(
            'PID 496 is reserved',
        );
        expect(uniqueValueError('PID', 256, 1, [256, 256], {})).toBeUndefined();
    });
});

describe('fillAutoAssigned', () => {
    const field = { key: 'pid', autoAssign: { start: 256, step: 8 }, reserved: [496], minimum: 32, maximum: 8190 };

    it('fills blank / 0 / out-of-range values in list order after every assigned value is taken', () => {
        expect(fillAutoAssigned([{ pid: 0 }, { pid: 256 }, {}, { pid: 9999 }], [field])).toEqual([
            { pid: 264 },
            { pid: 256 },
            { pid: 272 },
            { pid: 280 },
        ]);
    });

    it('keeps assigned values, even off-grid or duplicated (the engine reports those)', () => {
        const items = [{ pid: 300 }, { pid: 300 }];
        expect(fillAutoAssigned(items, [field])).toEqual(items);
    });
});

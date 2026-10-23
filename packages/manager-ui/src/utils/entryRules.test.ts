import { describe, it, expect } from 'vitest';
import { readEntry, sameValue } from './entryRules';

describe('readEntry — numbers (B-104)', () => {
    const offset = { type: 'number', min: -10000, max: 10000, unit: 'ms' };

    it('reads a number inside its bounds, either bound included', () => {
        expect(readEntry('-40', offset)).toEqual({ value: -40 });
        expect(readEntry(' 1500 ', offset)).toEqual({ value: 1500 });
        expect(readEntry('-10000', offset)).toEqual({ value: -10000 });
        expect(readEntry('10000', offset)).toEqual({ value: 10000 });
    });

    it('refuses a number out of bounds with the range and unit, never the nearest bound', () => {
        expect(readEntry('25000', offset)).toEqual({
            reason: 'Must be between -10000 and 10000 ms',
        });
        expect(readEntry('-10001', offset)).toEqual({
            reason: 'Must be between -10000 and 10000 ms',
        });
        expect(readEntry('-1', { type: 'number', min: 0 })).toEqual({
            reason: 'Must be at least 0',
        });
        expect(readEntry('61', { type: 'number', max: 60, unit: 'min' })).toEqual({
            reason: 'Must be at most 60 min',
        });
    });

    it('refuses an empty box or text the browser cannot parse; an optional box commits empty', () => {
        expect(readEntry('', offset)).toEqual({ reason: 'Enter a number' });
        expect(readEntry('  ', offset)).toEqual({ reason: 'Enter a number' });
        expect(readEntry('', offset, true)).toEqual({ reason: 'Enter a number' });
        expect(readEntry('abc', offset)).toEqual({ reason: 'Enter a number' });
        expect(readEntry('', { ...offset, optional: true })).toEqual({ value: '' });
        // Unparseable text is no empty override.
        expect(readEntry('', { ...offset, optional: true }, true)).toEqual({
            reason: 'Enter a number',
        });
    });

    it('an integer field takes whole numbers only', () => {
        const batch = { type: 'integer', min: 0, max: 100 };
        expect(readEntry('20', batch)).toEqual({ value: 20 });
        expect(readEntry('2.5', batch)).toEqual({ reason: 'Enter a whole number' });
        expect(readEntry('101', batch)).toEqual({ reason: 'Must be between 0 and 100' });
    });

    it('rounds to whole steps before the bounds, as the PID trims always have', () => {
        const trim = { type: 'number', min: -2000, max: 2000, step: 1, unit: 'ms' };
        expect(readEntry('12.6', trim)).toEqual({ value: 13 });
        expect(readEntry('-2000.4', trim)).toEqual({ value: -2000 });
        expect(readEntry('2000.6', trim)).toEqual({ reason: 'Must be between -2000 and 2000 ms' });
    });

    it('checks an enum and a caller rule after the bounds', () => {
        expect(readEntry('250', { type: 'number', enum: [100, 150, 500] })).toEqual({
            reason: 'Must be one of: 100, 150, 500',
        });
        expect(readEntry('150', { type: 'number', enum: [100, 150, 500] })).toEqual({ value: 150 });
        const taken = {
            type: 'number',
            check: (v: string | number) => (v === 256 ? 'taken' : undefined),
        };
        expect(readEntry('256', taken)).toEqual({ reason: 'taken' });
        expect(readEntry('264', taken)).toEqual({ value: 264 });
    });
});

describe('readEntry — text (B-104)', () => {
    it('keeps any text when the schema states no rule, an empty box included', () => {
        expect(readEntry('0.0.0.0', { type: 'string' })).toEqual({ value: '0.0.0.0' });
        expect(readEntry('', { type: 'string' })).toEqual({ value: '' });
        expect(readEntry('12', {})).toEqual({ value: '12' });
    });

    it('checks lengths in characters, a pattern, an enum and a caller rule', () => {
        const id = { type: 'string', minLength: 2, maxLength: 4 };
        expect(readEntry('a', id)).toEqual({ reason: 'Must be at least 2 characters' });
        expect(readEntry('abcde', id)).toEqual({ reason: 'Must be at most 4 characters' });
        expect(readEntry('éèêë', id)).toEqual({ value: 'éèêë' });
        expect(readEntry('a-1', { type: 'string', pattern: '^[a-z]+$' })).toEqual({
            reason: 'Not in the required format',
        });
        expect(readEntry('abc', { type: 'string', pattern: '^[a-z]+$' })).toEqual({ value: 'abc' });
        expect(readEntry('x', { type: 'string', enum: ['a', 'b'] })).toEqual({
            reason: 'Must be one of: a, b',
        });
        expect(readEntry('nope', { check: () => 'Enter an IPv4 address' })).toEqual({
            reason: 'Enter an IPv4 address',
        });
    });
});

describe('sameValue', () => {
    it('an entry equal to the stored value, or empty over an unset one, is unchanged', () => {
        expect(sameValue(5, 5)).toBe(true);
        expect(sameValue('', undefined)).toBe(true);
        expect(sameValue('', null)).toBe(true);
        expect(sameValue('a', 'a')).toBe(true);
        expect(sameValue(0, -0)).toBe(true);
        expect(sameValue(5, '5')).toBe(false);
        expect(sameValue(0, '')).toBe(false);
        expect(sameValue(0, undefined)).toBe(false);
        expect(sameValue(0, 'x')).toBe(false);
    });
});

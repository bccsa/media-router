import { describe, it, expect } from 'vitest';
import { checkStartSettings } from './startSettings.js';

const SCHEMA = {
    type: 'object',
    properties: {
        batchMs: { type: 'integer', minimum: 0, maximum: 10, default: 5 },
        gain: { type: 'number', minimum: -20, maximum: 20 },
        range: { type: 'number', enum: [100, 150, 500], default: 150 },
        level: { type: 'number', minimum: 0, maximum: 150, default: 100, 'x-maxFrom': 'range' },
        label: { type: 'string', minLength: 2 },
        stepMs: { type: 'number', maximum: 9, multipleOf: 3, default: 3 },
    },
};

describe('checkStartSettings (B-103)', () => {
    it('passes valid settings untouched, filling in the defaults', () => {
        const settings: Record<string, unknown> = { gain: 3, range: 500, level: 400 };
        expect(checkStartSettings(SCHEMA, settings)).toBeNull();
        expect(settings).toEqual({ batchMs: 5, gain: 3, range: 500, level: 400, stepMs: 3 });
    });

    it('brings a number to the bound it is past, in place, with or without a default', () => {
        const settings: Record<string, unknown> = { batchMs: 12, gain: -50, level: 200 };
        expect(checkStartSettings(SCHEMA, settings)).toEqual({
            errors: ['/batchMs must be <= 10', '/gain must be >= -20', '/level must be <= 150'],
            clamped: ['batchMs 12 -> 10', 'gain -50 -> -20', 'level 200 -> 150'],
            reset: [],
        });
        expect(settings).toMatchObject({ batchMs: 10, gain: -20, level: 150 });
    });

    it('resets a value wrong in any other way, a bound among its errors included', () => {
        // Past a bound and wrong besides (not a whole number, not a multiple of 3): no bound mends it.
        const settings: Record<string, unknown> = {
            batchMs: 12.5,
            range: 250,
            level: '90',
            stepMs: 12.5,
        };
        expect(checkStartSettings(SCHEMA, settings)).toMatchObject({
            clamped: [],
            reset: ['batchMs -> 5', 'range -> 150', 'level -> 100', 'stepMs -> 3'],
        });
        expect(settings).toMatchObject({ batchMs: 5, range: 150, level: 100, stepMs: 3 });
    });

    it('leaves an invalid value without a default as it is, as before', () => {
        const settings: Record<string, unknown> = { label: 'x' };
        expect(checkStartSettings(SCHEMA, settings)).toEqual({
            errors: ['/label must NOT have fewer than 2 characters'],
            clamped: [],
            reset: [],
        });
        expect(settings.label).toBe('x');
    });
});

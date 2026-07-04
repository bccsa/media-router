import { describe, it, expect } from 'vitest';
import { matchShowWhen } from './showWhen';

const from = (values: Record<string, unknown>) => (key: string) => values[key];

describe('matchShowWhen', () => {
    it('always shows when there is no condition', () => {
        expect(matchShowWhen(undefined, from({}))).toBe(true);
        expect(matchShowWhen('', from({}))).toBe(true);
    });

    it('matches a single value', () => {
        expect(matchShowWhen('codec=h264', from({ codec: 'h264' }))).toBe(true);
        expect(matchShowWhen('codec=h264', from({ codec: 'h265' }))).toBe(false);
    });

    it('matches any of a comma-separated list', () => {
        const cond = 'encoderImpl=software,va,auto';
        expect(matchShowWhen(cond, from({ encoderImpl: 'va' }))).toBe(true);
        expect(matchShowWhen(cond, from({ encoderImpl: 'auto' }))).toBe(true);
        expect(matchShowWhen(cond, from({ encoderImpl: 'v4l2' }))).toBe(false);
    });

    it('treats a missing/undefined value as empty string', () => {
        expect(matchShowWhen('codec=h264', from({}))).toBe(false);
        expect(matchShowWhen('codec=', from({}))).toBe(true);
    });

    it('coerces non-string values before comparing', () => {
        expect(matchShowWhen('n=5', from({ n: 5 }))).toBe(true);
    });
});

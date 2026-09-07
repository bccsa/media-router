import { describe, it, expect } from 'vitest';
import { DEFAULT_302M_BIT_DEPTH, s302mFormatFor } from './pcmBitDepth.js';

describe('s302mFormatFor', () => {
    it('defaults to 16-bit (S16LE) when the module has no pcmBitDepth', () => {
        expect(DEFAULT_302M_BIT_DEPTH).toBe(16);
        expect(s302mFormatFor(undefined)).toBe('S16LE');
        expect(s302mFormatFor(16)).toBe('S16LE');
        expect(s302mFormatFor('16')).toBe('S16LE');
    });
    it('opts into 24-bit (S32LE) only for 24', () => {
        expect(s302mFormatFor(24)).toBe('S32LE');
        expect(s302mFormatFor('24')).toBe('S32LE');
        expect(s302mFormatFor(32)).toBe('S16LE');
        expect(s302mFormatFor('junk')).toBe('S16LE');
    });
});

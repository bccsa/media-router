/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { statColorClass } from './useStatColor';

describe('statColorClass', () => {
    const warn = 60;
    const crit = 90;

    it('returns text-muted when below warning threshold', () => {
        expect(statColorClass(0, warn, crit)).toBe('text-muted');
        expect(statColorClass(30, warn, crit)).toBe('text-muted');
        expect(statColorClass(59, warn, crit)).toBe('text-muted');
    });

    it('returns text-warning at exactly the warning threshold', () => {
        expect(statColorClass(60, warn, crit)).toBe('text-warning');
    });

    it('returns text-warning between warning and critical', () => {
        expect(statColorClass(75, warn, crit)).toBe('text-warning');
        expect(statColorClass(89, warn, crit)).toBe('text-warning');
    });

    it('returns text-error at exactly the critical threshold', () => {
        expect(statColorClass(90, warn, crit)).toBe('text-error');
    });

    it('returns text-error above critical threshold', () => {
        expect(statColorClass(95, warn, crit)).toBe('text-error');
        expect(statColorClass(100, warn, crit)).toBe('text-error');
    });

    it('handles zero thresholds', () => {
        expect(statColorClass(0, 0, 0)).toBe('text-error');
    });

    it('handles equal warn and crit thresholds', () => {
        expect(statColorClass(49, 50, 50)).toBe('text-muted');
        expect(statColorClass(50, 50, 50)).toBe('text-error');
    });

    it('handles negative values', () => {
        expect(statColorClass(-10, 50, 90)).toBe('text-muted');
    });
});

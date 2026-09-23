import { describe, it, expect, vi, afterEach } from 'vitest';
import { SeqDedup } from './SeqDedup.js';

describe('SeqDedup', () => {
    afterEach(() => vi.useRealTimers());

    it('flags a repeated (session, seq) and passes a new one', () => {
        const d = new SeqDedup();
        expect(d.isDuplicate('s1', 1)).toBe(false);
        expect(d.isDuplicate('s1', 1)).toBe(true);
        expect(d.isDuplicate('s1', 2)).toBe(false);
    });

    it('keys on the session too — a reborn peer restarting at seq 1 is not a replay', () => {
        const d = new SeqDedup();
        expect(d.isDuplicate('old-session', 1)).toBe(false);
        expect(d.isDuplicate('new-session', 1)).toBe(false);
    });

    it('evicts by age so the table stays bounded', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
        const d = new SeqDedup(1000);
        d.isDuplicate('s', 1);
        vi.setSystemTime(new Date('2026-09-23T10:00:05Z'));
        d.isDuplicate('s', 2);
        expect(d.size).toBe(1); // seq 1 aged out on insert of seq 2
        expect(d.isDuplicate('s', 1)).toBe(false); // forgotten — treated as new
    });

    it('caps the entry count as a backstop', () => {
        const d = new SeqDedup(60_000, 3);
        for (let i = 1; i <= 5; i++) d.isDuplicate('s', i);
        expect(d.size).toBe(3);
    });
});

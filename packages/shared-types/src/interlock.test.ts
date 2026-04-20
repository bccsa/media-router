import { describe, it, expect } from 'vitest';
import { InterlockSchema, InterlocksSchema, validateInterlocksInvariants } from './validation.js';
import type { Interlock } from './index.js';

describe('InterlockSchema', () => {
    it('accepts a valid interlock', () => {
        const r = InterlockSchema.safeParse({
            id: 'ilk-1',
            name: 'Studio Mics',
            members: ['m1', 'm2'],
        });
        expect(r.success).toBe(true);
    });

    it('accepts optional color', () => {
        const r = InterlockSchema.safeParse({
            id: 'ilk-1',
            name: 'Studio Mics',
            members: [],
            color: '#a855f7',
        });
        expect(r.success).toBe(true);
    });

    it('rejects missing id', () => {
        const r = InterlockSchema.safeParse({ name: 'x', members: [] });
        expect(r.success).toBe(false);
    });

    it('rejects empty id', () => {
        const r = InterlockSchema.safeParse({ id: '', name: 'x', members: [] });
        expect(r.success).toBe(false);
    });

    it('rejects missing name', () => {
        const r = InterlockSchema.safeParse({ id: 'ilk-1', members: [] });
        expect(r.success).toBe(false);
    });

    it('rejects non-array members', () => {
        const r = InterlockSchema.safeParse({ id: 'ilk-1', name: 'x', members: 'm1' });
        expect(r.success).toBe(false);
    });

    it('rejects empty member strings', () => {
        const r = InterlockSchema.safeParse({ id: 'ilk-1', name: 'x', members: [''] });
        expect(r.success).toBe(false);
    });

    it('InterlocksSchema accepts an array of interlocks', () => {
        const r = InterlocksSchema.safeParse([
            { id: 'a', name: 'A', members: [] },
            { id: 'b', name: 'B', members: ['m1'] },
        ]);
        expect(r.success).toBe(true);
    });

    it('Interlock TS type is exported and assignable', () => {
        const ilk: Interlock = { id: 'ilk-1', name: 'x', members: ['m1'] };
        expect(ilk.id).toBe('ilk-1');
    });
});

describe('validateInterlocksInvariants', () => {
    it('no issues for empty input', () => {
        expect(validateInterlocksInvariants([])).toEqual([]);
    });

    it('no issues for well-formed interlocks', () => {
        const issues = validateInterlocksInvariants([
            { id: 'a', members: ['m1', 'm2'] },
            { id: 'b', members: ['m3'] },
        ]);
        expect(issues).toEqual([]);
    });

    it('flags duplicate interlock ids', () => {
        const issues = validateInterlocksInvariants([
            { id: 'a', members: ['m1'] },
            { id: 'a', members: ['m2'] },
        ]);
        expect(issues).toEqual([{ kind: 'duplicate-id', interlockId: 'a' }]);
    });

    it('flags a moduleId appearing in two groups', () => {
        const issues = validateInterlocksInvariants([
            { id: 'a', members: ['m1', 'm2'] },
            { id: 'b', members: ['m2', 'm3'] },
        ]);
        expect(issues).toContainEqual({
            kind: 'duplicate-member',
            interlockId: 'b',
            moduleId: 'm2',
        });
    });

    it('flags unknown moduleIds when a module set is provided', () => {
        const issues = validateInterlocksInvariants([{ id: 'a', members: ['m1', 'ghost'] }], {
            knownModuleIds: new Set(['m1', 'm2']),
        });
        expect(issues).toContainEqual({
            kind: 'unknown-member',
            interlockId: 'a',
            moduleId: 'ghost',
        });
    });

    it('flags ineligible modules when an eligibility predicate is provided', () => {
        const issues = validateInterlocksInvariants([{ id: 'a', members: ['eligible', 'nope'] }], {
            isEligible: (id) => id === 'eligible',
        });
        expect(issues).toContainEqual({
            kind: 'ineligible-member',
            interlockId: 'a',
            moduleId: 'nope',
        });
    });

    it('reports multiple independent issues in one pass', () => {
        const issues = validateInterlocksInvariants(
            [
                { id: 'a', members: ['m1'] },
                { id: 'a', members: ['m2'] },
                { id: 'b', members: ['m1'] },
            ],
            { knownModuleIds: new Set(['m1']) },
        );
        expect(issues).toContainEqual({ kind: 'duplicate-id', interlockId: 'a' });
        expect(issues).toContainEqual({
            kind: 'duplicate-member',
            interlockId: 'b',
            moduleId: 'm1',
        });
        expect(issues).toContainEqual({ kind: 'unknown-member', interlockId: 'a', moduleId: 'm2' });
    });
});

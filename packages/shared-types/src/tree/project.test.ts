import { describe, it, expect } from 'vitest';
import { prune, projectOp } from './project.js';
import { parsePattern } from './patterns.js';

const modules = {
    m1: { health: 'ok', settings: { volume: 80 } },
    m2: { health: 'warning', settings: { volume: 20 } },
};

describe('prune', () => {
    it('keeps only what the relative patterns reach', () => {
        expect(prune(modules, [['+', 'health']])).toEqual({ m1: { health: 'ok' }, m2: { health: 'warning' } });
        expect(prune(modules, [['m2', 'settings']])).toEqual({ m2: { settings: { volume: 20 } } });
    });

    it('an empty relative pattern keeps the whole node', () => {
        expect(prune(modules, [[]])).toBe(modules);
    });

    it('returns undefined when nothing matched', () => {
        expect(prune(modules, [['m9']])).toBeUndefined();
        expect(prune(42, [['x']])).toBeUndefined();
    });

    it('addresses array elements by id, then by index', () => {
        const conns = [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }, { label: 'no id' }];
        expect(prune(conns, [['c2', 'label']])).toEqual([{ label: 'B' }]);
        expect(prune(conns, [['2']])).toEqual([{ label: 'no id' }]);
        expect(prune(conns, [['+', 'label']])).toHaveLength(3);
    });
});

describe('projectOp', () => {
    const op = { op: 'replace' as const, path: '/engines/e/modules', value: modules };
    const at = ['engines', 'e', 'modules'];

    it('passes an op through when a pattern covers its path', () => {
        expect(projectOp(op, at, [parsePattern('/engines/e')])).toBe(op);
    });

    it('prunes an ancestor replace to the subscriber patterns', () => {
        const out = projectOp(op, at, [parsePattern('/engines/e/modules/+/health')]);
        expect(out).toEqual({ ...op, value: { m1: { health: 'ok' }, m2: { health: 'warning' } } });
    });

    it('clears the subscriber branch when the new value has nothing for it', () => {
        const out = projectOp(op, at, [parsePattern('/engines/e/modules/gone/health')]);
        expect(out).toEqual({ ...op, value: {} });
    });

    it('delivers an ancestor remove unchanged', () => {
        const rm = { op: 'remove' as const, path: '/engines/e' };
        expect(projectOp(rm, ['engines', 'e'], [parsePattern('/engines/e/info')])).toBe(rm);
    });

    it('returns null when no pattern overlaps', () => {
        expect(projectOp(op, at, [parsePattern('/engines/other')])).toBeNull();
    });

    it('turns a primitive ancestor write into a remove for deeper patterns', () => {
        const prim = { op: 'replace' as const, path: '/a', value: 5 };
        expect(projectOp(prim, ['a'], [parsePattern('/a/b')])).toEqual({ op: 'remove', path: '/a' });
    });
});

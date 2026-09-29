import { describe, it, expect } from 'vitest';
import { applyTreeOp, getAt, keysOf } from './apply.js';

function tree() {
    return {
        engines: {
            e1: {
                modules: { m1: { settings: { volume: 80 } } },
                connections: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }],
            },
        },
    } as Record<string, unknown>;
}

describe('getAt / keysOf', () => {
    it('walks objects and array elements by id', () => {
        const t = tree();
        expect(getAt(t, ['engines', 'e1', 'modules', 'm1', 'settings', 'volume'])).toBe(80);
        expect(getAt(t, ['engines', 'e1', 'connections', 'c2', 'label'])).toBe('B');
        expect(getAt(t, ['engines', 'nope', 'x'])).toBeUndefined();
    });

    it('lists object keys and array element ids', () => {
        const t = tree();
        expect(keysOf(getAt(t, ['engines', 'e1']))).toEqual(['modules', 'connections']);
        expect(keysOf(getAt(t, ['engines', 'e1', 'connections']))).toEqual(['c1', 'c2']);
    });
});

describe('applyTreeOp', () => {
    it('replaces a leaf and creates parents only on add', () => {
        const t = tree();
        expect(applyTreeOp(t, { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 60 })).toBe(true);
        expect(applyTreeOp(t, { op: 'replace', path: '/engines/e2/info/online', value: true })).toBe(false);
        expect(applyTreeOp(t, { op: 'add', path: '/engines/e2/info/online', value: true })).toBe(true);
        expect(getAt(t, ['engines', 'e2', 'info', 'online'])).toBe(true);
        expect(getAt(t, ['engines', 'e1', 'modules', 'm1', 'settings', 'volume'])).toBe(60);
    });

    it('addresses array elements by id', () => {
        const t = tree();
        applyTreeOp(t, { op: 'replace', path: '/engines/e1/connections/c2/label', value: 'Z' });
        applyTreeOp(t, { op: 'remove', path: '/engines/e1/connections/c1' });
        expect(getAt(t, ['engines', 'e1', 'connections'])).toEqual([{ id: 'c2', label: 'Z' }]);
    });

    it('never duplicates an echoed append of the same id', () => {
        const t = tree();
        const add = { op: 'add' as const, path: '/engines/e1/connections/-', value: { id: 'c3', label: 'C' } };
        applyTreeOp(t, add);
        applyTreeOp(t, { ...add, value: { id: 'c3', label: 'C2' } });
        const conns = getAt(t, ['engines', 'e1', 'connections']) as unknown[];
        expect(conns).toHaveLength(3);
        expect(conns[2]).toEqual({ id: 'c3', label: 'C2' });
    });

    it('creates an array parent for an append', () => {
        const t: Record<string, unknown> = {};
        applyTreeOp(t, { op: 'add', path: '/engines/e1/logs/-', value: { msg: 'x' } });
        expect(getAt(t, ['engines', 'e1', 'logs'])).toEqual([{ msg: 'x' }]);
    });

    it('drops a remove of something absent', () => {
        expect(applyTreeOp(tree(), { op: 'remove', path: '/engines/e1/modules/m9' })).toBe(false);
    });
});

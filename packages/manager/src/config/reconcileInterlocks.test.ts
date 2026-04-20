import { describe, it, expect } from 'vitest';
import { reconcileInterlocks } from './reconcileInterlocks.js';

function buildConfig(
    mods: Record<string, boolean | null>,
    groups: Array<{ id: string; members: string[] }>,
): Record<string, unknown> {
    const modules: Record<string, Record<string, unknown>> = {};
    for (const [id, on] of Object.entries(mods)) {
        modules[id] = on === null ? {} : { settings: { audioEnabled: on } };
    }
    return { modules, interlocks: groups, connections: [] };
}

describe('reconcileInterlocks', () => {
    it('no-op when there are no interlocks', () => {
        const config = buildConfig({ a: true }, []);
        expect(reconcileInterlocks(config)).toEqual([]);
    });

    it('no-op when exactly one member is hot', () => {
        const config = buildConfig({ a: true, b: false, c: false }, [
            { id: 'g1', members: ['a', 'b', 'c'] },
        ]);
        expect(reconcileInterlocks(config)).toEqual([]);
    });

    it('no-op when no member is hot', () => {
        const config = buildConfig({ a: false, b: false }, [{ id: 'g1', members: ['a', 'b'] }]);
        expect(reconcileInterlocks(config)).toEqual([]);
    });

    it('mutes all-but-first when two members are hot', () => {
        const config = buildConfig({ a: true, b: true, c: false }, [
            { id: 'g1', members: ['a', 'b', 'c'] },
        ]);
        const ops = reconcileInterlocks(config);
        expect(ops).toEqual([
            { op: 'replace', path: '/modules/b/settings/audioEnabled', value: false },
        ]);
        expect((config.modules as any).b.settings.audioEnabled).toBe(false);
        expect((config.modules as any).a.settings.audioEnabled).toBe(true);
    });

    it('mutes all-but-first when all three members are hot', () => {
        const config = buildConfig({ a: true, b: true, c: true }, [
            { id: 'g1', members: ['a', 'b', 'c'] },
        ]);
        const ops = reconcileInterlocks(config);
        expect(ops).toEqual([
            { op: 'replace', path: '/modules/b/settings/audioEnabled', value: false },
            { op: 'replace', path: '/modules/c/settings/audioEnabled', value: false },
        ]);
    });

    it('array order is priority (second member first, wins)', () => {
        // Members order is ["b","a","c"], and both a and b are hot.
        // b appears first → b wins, a gets muted.
        const config = buildConfig({ a: true, b: true, c: false }, [
            { id: 'g1', members: ['b', 'a', 'c'] },
        ]);
        const ops = reconcileInterlocks(config);
        expect(ops).toEqual([
            { op: 'replace', path: '/modules/a/settings/audioEnabled', value: false },
        ]);
    });

    it('strips orphan members (moduleId not in config.modules)', () => {
        const config = buildConfig({ a: false, c: false }, [
            { id: 'g1', members: ['a', 'ghost', 'c'] },
        ]);
        const ops = reconcileInterlocks(config);
        expect(ops).toContainEqual({
            op: 'replace',
            path: '/interlocks/g1/members',
            value: ['a', 'c'],
        });
        expect((config.interlocks as any)[0].members).toEqual(['a', 'c']);
    });

    it('treats missing audioEnabled as hot (undefined !== false)', () => {
        // Fresh modules without settings.audioEnabled are considered hot by default.
        const config = buildConfig({ a: null, b: null }, [{ id: 'g1', members: ['a', 'b'] }]);
        const ops = reconcileInterlocks(config);
        expect(ops).toEqual([
            { op: 'replace', path: '/modules/b/settings/audioEnabled', value: false },
        ]);
    });

    it('independent groups are reconciled independently', () => {
        const config = buildConfig({ a: true, b: true, c: true, d: true }, [
            { id: 'g1', members: ['a', 'b'] },
            { id: 'g2', members: ['c', 'd'] },
        ]);
        const ops = reconcileInterlocks(config);
        expect(ops).toEqual([
            { op: 'replace', path: '/modules/b/settings/audioEnabled', value: false },
            { op: 'replace', path: '/modules/d/settings/audioEnabled', value: false },
        ]);
    });
});

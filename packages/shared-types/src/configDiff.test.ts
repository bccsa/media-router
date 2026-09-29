import { describe, it, expect } from 'vitest';
import { diffConfig } from './configDiff.js';

const mod = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ pluginId: 'mixer', enabled: true, settings, ...extra });
const edge = (id: string, sink = 'b', extra: Record<string, unknown> = {}) => ({
    id, sourceModuleId: 'a', sourcePortId: 'out', sinkModuleId: sink, sinkPortId: 'in', ...extra,
});

describe('diffConfig', () => {
    it('is empty for equal configs', () => {
        const c = { modules: { a: mod({ v: 1 }) }, connections: [edge('c1')], interlocks: [] };
        expect(diffConfig(c, structuredClone(c))).toEqual([]);
    });

    it('settings per key, other module fields whole', () => {
        const from = { modules: { a: mod({ v: 1, gone: 2 }) } };
        const to = { modules: { a: mod({ v: 3, fresh: 4 }, { enabled: false, displayName: 'A' }) } };
        expect(diffConfig(from, to)).toEqual([
            { op: 'replace', path: '/modules/a/enabled', value: false },
            { op: 'add', path: '/modules/a/displayName', value: 'A' },
            { op: 'replace', path: '/modules/a/settings/v', value: 3 },
            { op: 'remove', path: '/modules/a/settings/gone' },
            { op: 'add', path: '/modules/a/settings/fresh', value: 4 },
        ]);
    });

    it('modules and connections added and removed, removes first', () => {
        const from = { modules: { a: mod({}), old: mod({}) }, connections: [edge('c1', 'old')] };
        const to = { modules: { a: mod({}), b: mod({}) }, connections: [edge('c2')] };
        expect(diffConfig(from, to)).toEqual([
            { op: 'remove', path: '/connections/c1' },
            { op: 'remove', path: '/modules/old' },
            { op: 'add', path: '/modules/b', value: mod({}) },
            { op: 'add', path: '/connections/-', value: edge('c2') },
        ]);
    });

    it('a re-pointed edge is removed and re-added; a channel map changes in place', () => {
        const map = [{ source: 0, sink: 1 }];
        const from = { modules: {}, connections: [edge('c1'), edge('c2')] };
        const to = { modules: {}, connections: [edge('c1', 'z'), edge('c2', 'b', { channelMap: map })] };
        expect(diffConfig(from, to)).toEqual([
            { op: 'remove', path: '/connections/c1' },
            { op: 'add', path: '/connections/-', value: edge('c1', 'z') },
            { op: 'replace', path: '/connections/c2/channelMap', value: map },
        ]);
    });

    it('interlocks go whole', () => {
        const to = { modules: {}, interlocks: [{ id: 'i1', members: ['a', 'b'] }] };
        expect(diffConfig({ modules: {} }, to)).toEqual([{ op: 'add', path: '/interlocks', value: to.interlocks }]);
        expect(diffConfig({ modules: {}, interlocks: [] }, to)[0].op).toBe('replace');
    });
});

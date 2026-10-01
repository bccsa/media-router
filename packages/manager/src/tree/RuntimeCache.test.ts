import { describe, it, expect } from 'vitest';
import { RuntimeCache } from './RuntimeCache.js';

describe('RuntimeCache', () => {
    it('merges whole-module states and reports prev → next per module', () => {
        const c = new RuntimeCache();
        expect(c.mergeStates('e', { m1: { health: 'ok' } })).toEqual([
            { moduleId: 'm1', prev: undefined, next: { health: 'ok' } },
        ]);
        expect(c.mergeStates('e', { m1: { health: 'warning' } })[0].prev).toEqual({ health: 'ok' });
        expect(c.getStates('e')).toEqual({ m1: { health: 'warning' } });
    });

    it('strips vuData from stored states and ignores non-objects', () => {
        const c = new RuntimeCache();
        c.mergeStates('e', { m1: { health: 'ok', vuData: [-3] }, m2: null as unknown as object });
        expect(c.getStates('e')).toEqual({ m1: { health: 'ok' } });
    });

    it('a purged module stays gone until its tombstone is lifted', () => {
        const c = new RuntimeCache();
        c.mergeStates('e', { m1: { health: 'ok' } });
        c.setVu('e', { m1: [-1] });
        c.purgeModuleStates('e', ['m1']);
        expect(c.getStates('e')).toEqual({});
        expect(c.getVu('e')).toEqual({});
        expect(c.mergeStates('e', { m1: { health: 'ok' } })).toEqual([]);
        c.setVu('e', { m1: [-1] });
        expect(c.getVu('e')).toEqual({});
        c.clearModuleTombstones('e', ['m1']);
        expect(c.mergeStates('e', { m1: { health: 'ok' } })).toHaveLength(1);
    });

    it('applies leaf state ops; replace under a missing parent is dropped', () => {
        const c = new RuntimeCache();
        c.mergeStates('e', { m1: { statusData: { a: 1 } } });
        const applied = c.applyStateOps('e', [
            { op: 'replace', path: '/modules/m1/statusData/a', value: 2 },
            { op: 'replace', path: '/modules/m2/health', value: 'ok' },
            { op: 'replace', path: '/modules/m2/badges/x', value: 1 },
            { op: 'remove', path: '/modules/m1/error' },
            { op: 'replace', path: '/system/cpu', value: 5 },
        ]);
        expect(applied.map((o) => o.path)).toEqual(['/modules/m1/statusData/a', '/modules/m2/health', '/modules/m1/error']);
        expect(c.getStates('e')).toEqual({ m1: { statusData: { a: 2 } }, m2: { health: 'ok' } });
    });

    it('keeps data, device lists and plugin schemas per engine', () => {
        const c = new RuntimeCache();
        c.setData('e', 'ip', '10.0.0.1');
        c.setData('e', 'devices:audio-sink', [{ name: 'hw:0' }]);
        c.setData('e', 'pluginSchemas', { a: {} });
        expect(c.getData('e', 'ip')).toBe('10.0.0.1');
        expect(c.getDevices('e')).toEqual({ 'audio-sink': [{ name: 'hw:0' }] });
        expect(c.getPluginSchemas('e')).toEqual({ a: {} });
        expect(c.getData('other', 'ip')).toBeUndefined();
    });

    it('trims the log ring to LOG_MAX', () => {
        const c = new RuntimeCache();
        c.appendLogs('e', Array.from({ length: RuntimeCache.LOG_MAX + 5 }, (_, i) => i));
        const logs = c.getLogs('e');
        expect(logs).toHaveLength(RuntimeCache.LOG_MAX);
        expect(logs[0]).toBe(5);
    });

    it('clearEngine drops everything, including tombstones', () => {
        const c = new RuntimeCache();
        c.mergeStates('e', { m1: {} });
        c.purgeModuleStates('e', ['m2']);
        c.appendLogs('e', ['x']);
        c.clearEngine('e');
        expect(c.getStates('e')).toEqual({});
        expect(c.getLogs('e')).toEqual([]);
        expect(c.mergeStates('e', { m2: {} })).toHaveLength(1);
    });

    it('rename moves every cache to the new id, tombstones included', () => {
        const c = new RuntimeCache();
        c.mergeStates('old', { m1: { health: 'ok' } });
        c.purgeModuleStates('old', ['gone']);
        c.setData('old', 'ip', '1.2.3.4');
        c.appendLogs('old', ['x']);
        c.rename('old', 'new');
        expect(c.getStates('new')).toEqual({ m1: { health: 'ok' } });
        expect(c.getData('new', 'ip')).toBe('1.2.3.4');
        expect(c.getLogs('new')).toEqual(['x']);
        expect(c.getStates('old')).toEqual({});
        expect(c.mergeStates('new', { gone: {} })).toEqual([]);
    });
});

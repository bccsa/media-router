import { describe, it, expect } from 'vitest';
import { applyJsonPatch } from './CommandDispatcher.js';

describe('applyJsonPatch', () => {
    it('replaces a top-level field', () => {
        const obj: Record<string, unknown> = { name: 'old' };
        applyJsonPatch(obj, [{ op: 'replace', path: '/name', value: 'new' }]);
        expect(obj.name).toBe('new');
    });

    it('replaces a nested field', () => {
        const obj: Record<string, unknown> = { modules: { 'mod-1': { displayName: 'Old' } } };
        applyJsonPatch(obj, [{ op: 'replace', path: '/modules/mod-1/displayName', value: 'New' }]);
        expect((obj.modules as any)['mod-1'].displayName).toBe('New');
    });

    it('adds a new nested field', () => {
        const obj: Record<string, unknown> = { modules: { 'mod-1': {} } };
        applyJsonPatch(obj, [{ op: 'add', path: '/modules/mod-1/settings', value: { vol: 100 } }]);
        expect((obj.modules as any)['mod-1'].settings).toEqual({ vol: 100 });
    });

    it('add creates intermediate objects', () => {
        const obj: Record<string, unknown> = {};
        applyJsonPatch(obj, [{ op: 'add', path: '/a/b/c', value: 42 }]);
        expect((obj as any).a.b.c).toBe(42);
    });

    it('removes a field', () => {
        const obj: Record<string, unknown> = { modules: { 'mod-1': { label: 'test' } } };
        applyJsonPatch(obj, [{ op: 'remove', path: '/modules/mod-1/label' }]);
        expect((obj.modules as any)['mod-1'].label).toBeUndefined();
    });

    it('skips replace on nonexistent intermediate path', () => {
        const obj: Record<string, unknown> = { modules: {} };
        applyJsonPatch(obj, [{ op: 'replace', path: '/modules/nonexistent/displayName', value: 'X' }]);
        // Should NOT set displayName on modules itself
        expect((obj.modules as any).displayName).toBeUndefined();
        expect((obj.modules as any).nonexistent).toBeUndefined();
    });

    it('handles array append with -', () => {
        const obj: Record<string, unknown> = { connections: [] as unknown[] };
        applyJsonPatch(obj, [{ op: 'add', path: '/connections/-', value: { id: 'conn-1' } }]);
        expect((obj.connections as unknown[]).length).toBe(1);
        expect((obj.connections as any)[0].id).toBe('conn-1');
    });

    it('handles multiple ops in sequence', () => {
        const obj: Record<string, unknown> = { a: 1, b: 2 };
        applyJsonPatch(obj, [
            { op: 'replace', path: '/a', value: 10 },
            { op: 'remove', path: '/b' },
            { op: 'add', path: '/c', value: 30 },
        ]);
        expect(obj.a).toBe(10);
        expect(obj.b).toBeUndefined();
        expect(obj.c).toBe(30);
    });

    it('does nothing on null object', () => {
        applyJsonPatch(null, [{ op: 'replace', path: '/x', value: 1 }]);
        // Should not throw
    });

    it('does nothing on empty path', () => {
        const obj: Record<string, unknown> = { x: 1 };
        applyJsonPatch(obj, [{ op: 'replace', path: '', value: 2 }]);
        expect(obj.x).toBe(1);
    });
});

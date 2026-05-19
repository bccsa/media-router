import { describe, it, expect } from 'vitest';
import type {
    StreamType,
    ModulePort,
    ModuleRuntimeState,
    DgramMessage,
    ManagerConnectionProfile,
    MpegTsStreamInfo,
    ControlIpcMessage,
    PluginManifest,
} from './index';
import { applyJsonPatch, coerceArray } from './index';

describe('shared-types', () => {
    it('StreamType accepts valid values', () => {
        const types: StreamType[] = ['audio/pcm', 'muxed/mpegts', 'video/raw'];
        expect(types).toHaveLength(3);
    });

    it('ModulePort shape is correct', () => {
        const port: ModulePort = {
            id: 'audio-out',
            direction: 'output',
            streamType: 'audio/pcm',
            label: 'Audio Out',
        };
        expect(port.id).toBe('audio-out');
        expect(port.direction).toBe('output');
    });

    it('ModuleRuntimeState shape is correct', () => {
        const state: ModuleRuntimeState = {
            running: true,
            ready: true,
            health: 'ok',
            pendingRestart: false,
        };
        expect(state.running).toBe(true);
        expect(state.health).toBe('ok');
    });

    it('DgramMessage shape is correct', () => {
        const msg: DgramMessage = {
            type: 'data',
            clientID: 'engine-1',
            data: { topic: 'state', message: { running: true } },
        };
        expect(msg.type).toBe('data');
        expect(msg.data.topic).toBe('state');
    });

    it('PluginManifest shape is correct', () => {
        // Synthetic manifest — not resolved against the filesystem. Field
        // shape is what's under test, not the engine path.
        const manifest: PluginManifest = {
            pluginId: 'note',
            displayName: 'Note',
            description: 'A plugin manifest fixture used to validate the type shape',
            category: 'utility',
            architectures: ['arm64', 'x86_64'],
            ports: [],
            configSchema: {},
            engine: './engine/NoteModule.ts',
        };
        expect(manifest.pluginId).toBe('note');
    });
});

describe('applyJsonPatch', () => {
    it('appends to an existing array via /-', () => {
        const obj: Record<string, unknown> = { connections: [{ id: 'a' }] };
        applyJsonPatch(obj, [{ op: 'add', path: '/connections/-', value: { id: 'b' } }]);
        expect(obj.connections).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    it('creates an array (not an object) when /- targets a missing field', () => {
        // Regression: previously produced { connections: { '-': {id:'a'} } },
        // which crashed downstream consumers calling .map / for-of.
        const obj: Record<string, unknown> = {};
        applyJsonPatch(obj, [{ op: 'add', path: '/connections/-', value: { id: 'a' } }]);
        expect(Array.isArray(obj.connections)).toBe(true);
        expect(obj.connections).toEqual([{ id: 'a' }]);
    });

    it('creates an array when an intermediate path leads to a numeric segment', () => {
        const obj: Record<string, unknown> = {};
        applyJsonPatch(obj, [{ op: 'add', path: '/list/0', value: 'x' }]);
        expect(Array.isArray(obj.list)).toBe(true);
        expect(obj.list).toEqual(['x']);
    });

    it('creates an object when an intermediate path leads to a string key', () => {
        const obj: Record<string, unknown> = {};
        applyJsonPatch(obj, [{ op: 'add', path: '/modules/foo/setting', value: 1 }]);
        expect(obj.modules).toEqual({ foo: { setting: 1 } });
    });

    it('drops a /- op when target is not an array, instead of poisoning it', () => {
        const obj: Record<string, unknown> = { interlocks: { existing: 1 } };
        applyJsonPatch(obj, [{ op: 'add', path: '/interlocks/-', value: { id: 'b' } }]);
        // The bad shape stays as-is; we don't make it worse by adding a '-' key.
        expect(obj.interlocks).toEqual({ existing: 1 });
    });

    it('removes by id from an array', () => {
        const obj: Record<string, unknown> = {
            connections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        };
        applyJsonPatch(obj, [{ op: 'remove', path: '/connections/b' }]);
        expect(obj.connections).toEqual([{ id: 'a' }, { id: 'c' }]);
    });

    it('replace at a leaf path overwrites the value', () => {
        const obj: Record<string, unknown> = { modules: { m1: { volume: 50 } } };
        applyJsonPatch(obj, [{ op: 'replace', path: '/modules/m1/volume', value: 80 }]);
        expect(obj.modules).toEqual({ m1: { volume: 80 } });
    });

    it('walks through arrays by id (browsers send id-paths)', () => {
        const obj: Record<string, unknown> = {
            connections: [
                { id: 'c1', label: 'old' },
                { id: 'c2', label: 'keep' },
            ],
        };
        applyJsonPatch(obj, [{ op: 'replace', path: '/connections/c1/label', value: 'new' }]);
        expect(obj.connections).toEqual([
            { id: 'c1', label: 'new' },
            { id: 'c2', label: 'keep' },
        ]);
    });

    it('replaces an array entry by id at the leaf', () => {
        const obj: Record<string, unknown> = {
            connections: [{ id: 'c1', label: 'old' }],
        };
        applyJsonPatch(obj, [
            { op: 'replace', path: '/connections/c1', value: { id: 'c1', label: 'new' } },
        ]);
        expect(obj.connections).toEqual([{ id: 'c1', label: 'new' }]);
    });

    it('drops a replace op whose id does not match (no string-key poisoning)', () => {
        const obj: Record<string, unknown> = { connections: [{ id: 'c1' }] };
        applyJsonPatch(obj, [{ op: 'replace', path: '/connections/missing', value: { id: 'x' } }]);
        // Array is unchanged, NOT augmented with `connections.missing = {…}`.
        expect(obj.connections).toEqual([{ id: 'c1' }]);
        expect((obj.connections as unknown as Record<string, unknown>).missing).toBeUndefined();
    });
});

describe('coerceArray', () => {
    it('passes arrays through unchanged (same reference)', () => {
        const arr = [{ id: 'a' }];
        expect(coerceArray(arr)).toBe(arr);
    });

    it('recovers an object-shaped corruption into an array of its object values', () => {
        // The exact shape produced by the pre-fix applyJsonPatch when /- ran
        // against a missing field.
        const corrupted = { '-': { id: 'a' } };
        expect(coerceArray(corrupted)).toEqual([{ id: 'a' }]);
    });

    it('returns [] for null, undefined, or primitives', () => {
        expect(coerceArray(null)).toEqual([]);
        expect(coerceArray(undefined)).toEqual([]);
        expect(coerceArray('oops')).toEqual([]);
        expect(coerceArray(42)).toEqual([]);
    });

    it('drops non-object values when recovering from a corruption', () => {
        // Defensive: only recover items that look like array elements.
        const corrupted = { '-': { id: 'a' }, garbage: 'string', also: null };
        expect(coerceArray(corrupted)).toEqual([{ id: 'a' }]);
    });
});

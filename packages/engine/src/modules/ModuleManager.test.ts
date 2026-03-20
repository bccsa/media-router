import { describe, it, expect, beforeEach } from 'vitest';
import { ModuleManager } from './ModuleManager.js';
import { PluginLoader } from '../plugins/PluginLoader.js';
import type { ModuleRuntimeState } from '@media-router/shared-types';

describe('ModuleManager', () => {
    let manager: ModuleManager;
    let pluginLoader: PluginLoader;

    beforeEach(() => {
        pluginLoader = new PluginLoader('/nonexistent'); // no real plugins needed
        manager = new ModuleManager(pluginLoader);
    });

    it('creates a module', () => {
        const mod = manager.createModule('test-1', 'example', { message: 'hello' });
        expect(mod.instanceId).toBe('test-1');
        expect(mod.pluginId).toBe('example');
        expect(manager.size).toBe(1);
    });

    it('starts and stops a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.startModule('test-1');

        const mod = manager.get('test-1')!;
        expect(mod.running).toBe(true);

        await manager.stopModule('test-1');
        expect(mod.running).toBe(false);
    });

    it('emits stateChange on start/stop', async () => {
        manager.createModule('test-1', 'example', {});

        const states: Array<{ id: string; state: ModuleRuntimeState }> = [];
        manager.on('stateChange', (id: string, state: ModuleRuntimeState) => {
            states.push({ id, state });
        });

        await manager.startModule('test-1');
        await manager.stopModule('test-1');

        expect(states.length).toBeGreaterThanOrEqual(2);
        expect(states[0].id).toBe('test-1');
    });

    it('deletes a module', async () => {
        manager.createModule('test-1', 'example', {});
        await manager.deleteModule('test-1');
        expect(manager.size).toBe(0);
        expect(manager.get('test-1')).toBeUndefined();
    });

    it('stops all modules', async () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});
        await manager.startModule('a');
        await manager.startModule('b');

        await manager.stopAll();
        expect(manager.get('a')!.running).toBe(false);
        expect(manager.get('b')!.running).toBe(false);
    });

    it('getAllStates returns all module states', () => {
        manager.createModule('a', 'example', {});
        manager.createModule('b', 'example', {});

        const states = manager.getAllStates();
        expect(Object.keys(states)).toEqual(['a', 'b']);
        expect(states.a.health).toBe('stopped');
    });

    it('throws on duplicate instanceId', () => {
        manager.createModule('dup', 'example', {});
        expect(() => manager.createModule('dup', 'example', {})).toThrow('already exists');
    });
});

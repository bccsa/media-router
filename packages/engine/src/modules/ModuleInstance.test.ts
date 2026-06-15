import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ModuleInstance } from './ModuleInstance.js';
import type { PluginModule, ModuleServices } from '../plugins/PluginModule.js';
import type { ModuleRuntimeState } from '@media-router/shared-types';

/** Minimal mock plugin that implements PluginModule + EventEmitter for event forwarding. */
class MockPlugin extends EventEmitter implements PluginModule {
    onInit = vi.fn().mockResolvedValue(undefined);
    onStart = vi.fn().mockResolvedValue(undefined);
    onStop = vi.fn().mockResolvedValue(undefined);
    onDestroy = vi.fn().mockResolvedValue(undefined);
    getLiveUpdatableParams = vi.fn().mockReturnValue([] as string[]);
    onLiveConfigUpdate = vi.fn().mockResolvedValue(undefined);

    private _state: ModuleRuntimeState = {
        running: false,
        ready: false,
        health: 'ok',
        pendingRestart: false,
    };

    getState(): ModuleRuntimeState {
        return { ...this._state };
    }

    // Optional delegates
    getPipeWireNodes = vi.fn().mockReturnValue({ source: 'src-node', sink: 'sink-node' });
    getPipeWireNodeForPort = vi.fn().mockReturnValue({ source: 'port-src' });
    getDynamicPorts = vi
        .fn()
        .mockReturnValue([
            { id: 'p1', direction: 'output' as const, streamType: 'audio/pcm', label: 'Out' },
        ]);
    getChildProcess = vi.fn().mockReturnValue(null);
    getProcessCount = vi.fn().mockReturnValue(2);
}

function createMockServices(overrides: Partial<ModuleServices> = {}): ModuleServices {
    return {
        pipeWire: {
            releaseAll: vi.fn().mockResolvedValue(undefined),
        } as any,
        mediaRouter: {
            releaseUdpPort: vi.fn(),
            releaseAllUdpPortsFor: vi.fn(),
        } as any,
        processManager: {
            releaseAll: vi.fn().mockResolvedValue(undefined),
        } as any,
        instanceId: 'test-instance',
        ...overrides,
    };
}

describe('ModuleInstance', () => {
    let plugin: MockPlugin;
    let instance: ModuleInstance;
    const config = { volume: 80, device: 'hw:0' };

    beforeEach(() => {
        plugin = new MockPlugin();
        instance = new ModuleInstance('inst-1', 'audio-decoder', plugin, { ...config });
    });

    // ---- Constructor ----

    it('stores instanceId, pluginId, config', () => {
        expect(instance.instanceId).toBe('inst-1');
        expect(instance.pluginId).toBe('audio-decoder');
        expect(instance.config).toEqual(config);
    });

    it('starts not running', () => {
        expect(instance.running).toBe(false);
    });

    // ---- start() ----

    it('calls plugin.onInit and onStart, sets running=true', async () => {
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledWith(config, undefined);
        expect(plugin.onStart).toHaveBeenCalled();
        expect(instance.running).toBe(true);
    });

    it('start() is idempotent when already running', async () => {
        await instance.start();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(1);
        expect(plugin.onStart).toHaveBeenCalledTimes(1);
    });

    it('stop then start does not re-call onInit (initialized guard)', async () => {
        await instance.start();
        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(1);
        expect(plugin.onStart).toHaveBeenCalledTimes(2);
    });

    it('start() emits stateChange', async () => {
        const spy = vi.fn();
        instance.on('stateChange', spy);
        await instance.start();
        expect(spy).toHaveBeenCalledWith(
            'inst-1',
            expect.objectContaining({ pendingRestart: false }),
        );
    });

    it('start() calls onStop for cleanup when onInit throws', async () => {
        plugin.onInit.mockRejectedValueOnce(new Error('init fail'));
        await expect(instance.start()).rejects.toThrow('init fail');
        expect(plugin.onStop).toHaveBeenCalled();
        expect(instance.running).toBe(false);
    });

    it('start() calls onStop for cleanup when onStart throws', async () => {
        plugin.onStart.mockRejectedValueOnce(new Error('start fail'));
        await expect(instance.start()).rejects.toThrow('start fail');
        expect(plugin.onStop).toHaveBeenCalled();
        expect(instance.running).toBe(false);
    });

    it('passes services to onInit when provided', async () => {
        const services = createMockServices();
        const inst = new ModuleInstance('inst-2', 'audio-decoder', plugin, { ...config }, services);
        await inst.start();
        expect(plugin.onInit).toHaveBeenCalledWith(config, services);
    });

    // ---- stop() ----

    it('calls plugin.onStop, sets running=false', async () => {
        await instance.start();
        await instance.stop();
        expect(plugin.onStop).toHaveBeenCalled();
        expect(instance.running).toBe(false);
    });

    it('stop() is idempotent when not running', async () => {
        await instance.stop();
        expect(plugin.onStop).not.toHaveBeenCalled();
    });

    it('stop() emits stateChange', async () => {
        await instance.start();
        const spy = vi.fn();
        instance.on('stateChange', spy);
        await instance.stop();
        expect(spy).toHaveBeenCalled();
    });

    it('stop() releases PipeWire and process resources', async () => {
        const services = createMockServices();
        const inst = new ModuleInstance('inst-3', 'test', plugin, {}, services);
        await inst.start();
        await inst.stop();
        expect(services.pipeWire.releaseAll).toHaveBeenCalledWith('inst-3');
        expect(services.processManager.releaseAll).toHaveBeenCalledWith('inst-3');
    });

    it('stop() swallows plugin.onStop errors', async () => {
        plugin.onStop.mockRejectedValueOnce(new Error('stop fail'));
        await instance.start();
        // Should not throw
        await instance.stop();
        expect(instance.running).toBe(false);
    });

    // ---- destroy() ----

    it('calls stop then plugin.onDestroy', async () => {
        await instance.start();
        await instance.destroy();
        expect(plugin.onStop).toHaveBeenCalled();
        expect(plugin.onDestroy).toHaveBeenCalled();
        expect(instance.running).toBe(false);
    });

    it('destroy() resets _initialized so next start re-runs onInit', async () => {
        await instance.start();
        await instance.destroy();
        // Re-create since destroy removes listeners, but the plugin is reusable
        const fresh = new ModuleInstance('inst-1', 'audio-decoder', plugin, { ...config });
        await fresh.start();
        // onInit called twice total: once for original, once after destroy+recreate
        expect(plugin.onInit).toHaveBeenCalledTimes(2);
    });

    it('destroy() removes all listeners', async () => {
        instance.on('stateChange', vi.fn());
        await instance.destroy();
        expect(instance.listenerCount('stateChange')).toBe(0);
    });

    it('destroy() detaches plugin listeners', async () => {
        await instance.destroy();
        // After detach, plugin events should not forward
        const spy = vi.fn();
        instance.on('vuData', spy);
        plugin.emit('vuData', [0.5]);
        expect(spy).not.toHaveBeenCalled();
    });

    // ---- getState() ----

    it('returns runtime state with pendingRestart', () => {
        const state = instance.getState();
        expect(state).toMatchObject({
            running: false,
            ready: false,
            health: 'ok',
            pendingRestart: false,
        });
    });

    // ---- Event forwarding ----

    it('forwards vuData events from plugin', () => {
        const spy = vi.fn();
        instance.on('vuData', spy);
        plugin.emit('vuData', [0.1, 0.2]);
        expect(spy).toHaveBeenCalledWith('inst-1', [0.1, 0.2]);
    });

    it('forwards stateChange events from plugin', () => {
        const spy = vi.fn();
        instance.on('stateChange', spy);
        plugin.emit('stateChange');
        expect(spy).toHaveBeenCalledWith('inst-1', expect.any(Object));
    });

    it('forwards configUpdated events from plugin', () => {
        const spy = vi.fn();
        instance.on('configUpdated', spy);
        plugin.emit('configUpdated', { volume: 90 });
        expect(spy).toHaveBeenCalledWith('inst-1', { volume: 90 });
    });

    // ---- applyConfigUpdate ----

    it('applies live params immediately via onLiveConfigUpdate', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['volume']);
        await instance.start();
        await instance.applyConfigUpdate({ volume: 50 });
        expect(plugin.onLiveConfigUpdate).toHaveBeenCalledWith({ volume: 50 });
        expect(instance.config.volume).toBe(50);
    });

    it('sets pendingRestart for non-live params', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['volume']);
        await instance.start();
        await instance.applyConfigUpdate({ device: 'hw:1' });
        expect(instance.getState().pendingRestart).toBe(true);
        expect(instance.config.device).toBe('hw:1');
    });

    it('handles mixed live and non-live params', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['volume']);
        await instance.start();
        await instance.applyConfigUpdate({ volume: 60, device: 'hw:2' });
        expect(plugin.onLiveConfigUpdate).toHaveBeenCalledWith({ volume: 60 });
        expect(instance.getState().pendingRestart).toBe(true);
    });

    it('does not set pendingRestart for all-live changes', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['volume']);
        await instance.start();
        await instance.applyConfigUpdate({ volume: 70 });
        expect(instance.getState().pendingRestart).toBe(false);
    });

    it('routes a live param through pendingRestart when isLiveChange rejects it', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['streams']);
        plugin.isLiveChange = vi.fn().mockReturnValue(false);
        await instance.start();
        await instance.applyConfigUpdate({ streams: [{ name: 'a' }, { name: 'b' }] });
        expect(plugin.isLiveChange).toHaveBeenCalledWith(
            'streams',
            [{ name: 'a' }, { name: 'b' }],
            undefined,
        );
        expect(plugin.onLiveConfigUpdate).not.toHaveBeenCalled();
        expect(instance.getState().pendingRestart).toBe(true);
        expect(instance.config.streams).toEqual([{ name: 'a' }, { name: 'b' }]);
    });

    it('applies a live param normally when isLiveChange accepts it', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['streams']);
        plugin.isLiveChange = vi.fn().mockReturnValue(true);
        await instance.start();
        await instance.applyConfigUpdate({ streams: [{ name: 'renamed' }] });
        expect(plugin.onLiveConfigUpdate).toHaveBeenCalledWith({
            streams: [{ name: 'renamed' }],
        });
        expect(instance.getState().pendingRestart).toBe(false);
    });

    // ---- Delegation methods ----

    it('getPipeWireNodes delegates to plugin', () => {
        expect(instance.getPipeWireNodes()).toEqual({ source: 'src-node', sink: 'sink-node' });
    });

    it('getPipeWireNodeForPort delegates to plugin', () => {
        expect(instance.getPipeWireNodeForPort('p1')).toEqual({ source: 'port-src' });
        expect(plugin.getPipeWireNodeForPort).toHaveBeenCalledWith('p1');
    });

    it('getDynamicPorts delegates to plugin', () => {
        const ports = instance.getDynamicPorts();
        expect(ports).toHaveLength(1);
        expect(ports![0].id).toBe('p1');
    });

    it('getChildProcess delegates to plugin', () => {
        expect(instance.getChildProcess()).toBeNull();
    });

    it('getProcessCount delegates to plugin', () => {
        expect(instance.getProcessCount()).toBe(2);
    });

    it('getPlugin returns the underlying plugin', () => {
        expect(instance.getPlugin()).toBe(plugin);
    });

    // ---- Edge: plugin without EventEmitter ----

    it('handles plugin without EventEmitter (no .on method)', () => {
        const plainPlugin: PluginModule = {
            onInit: vi.fn().mockResolvedValue(undefined),
            onStart: vi.fn().mockResolvedValue(undefined),
            onStop: vi.fn().mockResolvedValue(undefined),
            onDestroy: vi.fn().mockResolvedValue(undefined),
            getState: vi.fn().mockReturnValue({
                running: false,
                ready: false,
                health: 'ok',
                pendingRestart: false,
            }),
            getLiveUpdatableParams: vi.fn().mockReturnValue([]),
            onLiveConfigUpdate: vi.fn().mockResolvedValue(undefined),
        };
        // Should not throw
        const inst = new ModuleInstance('inst-plain', 'test', plainPlugin, {});
        expect(inst.instanceId).toBe('inst-plain');
    });

    it('returns undefined for optional delegates not implemented', () => {
        const plainPlugin: PluginModule = {
            onInit: vi.fn().mockResolvedValue(undefined),
            onStart: vi.fn().mockResolvedValue(undefined),
            onStop: vi.fn().mockResolvedValue(undefined),
            onDestroy: vi.fn().mockResolvedValue(undefined),
            getState: vi.fn().mockReturnValue({
                running: false,
                ready: false,
                health: 'ok',
                pendingRestart: false,
            }),
            getLiveUpdatableParams: vi.fn().mockReturnValue([]),
            onLiveConfigUpdate: vi.fn().mockResolvedValue(undefined),
        };
        const inst = new ModuleInstance('inst-no-opts', 'test', plainPlugin, {});
        expect(inst.getPipeWireNodes()).toBeUndefined();
        expect(inst.getPipeWireNodeForPort('x')).toBeUndefined();
        expect(inst.getDynamicPorts()).toBeUndefined();
        expect(inst.getChildProcess()).toBeNull();
        expect(inst.getProcessCount()).toBe(0);
    });
});

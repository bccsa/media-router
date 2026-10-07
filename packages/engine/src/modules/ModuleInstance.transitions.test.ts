import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleInstance } from './ModuleInstance.js';
import type { PluginModule } from '../plugins/PluginModule.js';

/** A promise the test resolves by hand — stands in for a slow onStart/onStop. */
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

/** Let every queued microtask and timer callback run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function createPlugin(calls: string[]) {
    return {
        onInit: vi.fn(async () => void calls.push('init')),
        onStart: vi.fn(async () => void calls.push('start')),
        onStop: vi.fn(async () => void calls.push('stop')),
        onDestroy: vi.fn(async () => void calls.push('destroy')),
        getState: () => ({
            running: false,
            ready: false,
            health: 'ok' as const,
            pendingRestart: false,
        }),
        getLiveUpdatableParams: () => [],
        onLiveConfigUpdate: vi.fn().mockResolvedValue(undefined),
    } satisfies PluginModule;
}

// #821: start, stop and destroy on one instance never overlap.
describe('ModuleInstance transitions', () => {
    let calls: string[];
    let plugin: ReturnType<typeof createPlugin>;
    let instance: ModuleInstance;

    beforeEach(() => {
        calls = [];
        plugin = createPlugin(calls);
        instance = new ModuleInstance('inst-1', 'clariocast', plugin, {});
    });

    it('a stop issued during a start waits for it, then stops what it brought up', async () => {
        const probe = deferred();
        plugin.onStart.mockImplementationOnce(async () => {
            calls.push('start');
            await probe.promise; // e.g. ClarioCast probing its input after binding :2000
            calls.push('started');
        });

        const starting = instance.start();
        await settle();
        expect(instance.running).toBe(false); // in flight
        const stopping = instance.stop();
        await settle();
        expect(plugin.onStop).not.toHaveBeenCalled();

        probe.resolve();
        await Promise.all([starting, stopping]);

        expect(calls).toEqual(['init', 'start', 'started', 'stop']);
        expect(instance.running).toBe(false);
    });

    it('destroy() during a start stops it, and a later start() is ignored', async () => {
        const probe = deferred();
        plugin.onStart.mockImplementationOnce(async () => {
            calls.push('start');
            await probe.promise;
        });

        const starting = instance.start();
        await settle();
        const destroying = instance.destroy();
        // A caller still holding the old instance (a bus executor) restarts it.
        const late = instance.start();

        probe.resolve();
        await Promise.all([starting, destroying, late]);

        expect(calls).toEqual(['init', 'start', 'stop', 'destroy']);
        expect(instance.running).toBe(false);
    });

    it('a second start() during a start does not run onStart again', async () => {
        const probe = deferred();
        plugin.onStart.mockImplementationOnce(async () => {
            calls.push('start');
            await probe.promise;
        });

        const first = instance.start();
        const second = instance.start();
        probe.resolve();
        await Promise.all([first, second]);

        expect(plugin.onStart).toHaveBeenCalledTimes(1);
        expect(instance.running).toBe(true);
    });

    it('a start() during a stop runs after it — the bounce ends running', async () => {
        await instance.start();
        const teardown = deferred();
        plugin.onStop.mockImplementationOnce(async () => {
            calls.push('stop');
            await teardown.promise;
        });

        const stopping = instance.stop();
        const starting = instance.start();
        teardown.resolve();
        await Promise.all([stopping, starting]);

        expect(calls).toEqual(['init', 'start', 'stop', 'start']);
        expect(instance.running).toBe(true);
    });

    it('a failed start does not block the next transition', async () => {
        plugin.onStart.mockRejectedValueOnce(new Error('start fail'));

        await expect(instance.start()).rejects.toThrow('start fail');
        await instance.start();

        expect(instance.running).toBe(true);
    });
});

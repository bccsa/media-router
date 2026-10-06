import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ModuleInstance } from './ModuleInstance.js';
import type { PluginModule } from '../plugins/PluginModule.js';

/**
 * A start applies every saved setting (ADR-0029). Field 2026-10-04, BCC Mulanje
 * .24: an audio-output's device was changed and the module restarted, but its
 * remap-sink was rebuilt on the OLD card — the plugin read the device in
 * onInit, which a restart never re-ran, and the restart cleared the pending
 * flag anyway.
 */
class Plugin extends EventEmitter implements PluginModule {
    onInit = vi.fn().mockResolvedValue(undefined);
    onStart = vi.fn().mockResolvedValue(undefined);
    onStop = vi.fn().mockResolvedValue(undefined);
    onDestroy = vi.fn().mockResolvedValue(undefined);
    getLiveUpdatableParams = vi.fn().mockReturnValue([] as string[]);
    onLiveConfigUpdate = vi.fn().mockResolvedValue(undefined);
    getState() {
        return { running: false, ready: false, health: 'ok' as const, pendingRestart: false };
    }
}

describe('ModuleInstance — a start applies pending non-live settings', () => {
    let plugin: Plugin;
    let instance: ModuleInstance;

    beforeEach(() => {
        plugin = new Plugin();
        instance = new ModuleInstance('out-1', 'audio-output', plugin, { device: 'card2' });
    });

    it('re-runs onInit with the current config on the start after a non-live change', async () => {
        await instance.start();
        await instance.applyConfigUpdate({ device: 'card3' });
        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(2);
        expect(plugin.onInit).toHaveBeenLastCalledWith(
            expect.objectContaining({ device: 'card3' }),
            undefined,
        );
        expect(instance.getState().pendingRestart).toBe(false);
    });

    it('does not re-run onInit after live-only changes', async () => {
        plugin.getLiveUpdatableParams.mockReturnValue(['volume']);
        await instance.start();
        await instance.applyConfigUpdate({ volume: 50 });
        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(1);
    });

    it('does not re-run onInit for a route playout-offset change', async () => {
        await instance.start();
        await instance.applyConfigUpdate({ playoutOffsetMs: 120 });
        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(1);
    });

    it('re-inits once: the next restart with nothing pending does not', async () => {
        await instance.start();
        await instance.applyConfigUpdate({ device: 'card3' });
        await instance.stop();
        await instance.start();
        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(2);
    });

    it('a change saved while stopped (disabled) re-inits on the next start', async () => {
        await instance.start();
        await instance.stop();
        await instance.applyConfigUpdate({ device: 'card3' });
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(2);
        expect(instance.getState().pendingRestart).toBe(false);
    });

    it('a change saved while a start is in flight stays pending until applied', async () => {
        await instance.start();
        await instance.stop();
        let release!: () => void;
        plugin.onStart.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
        const starting = instance.start();
        await instance.applyConfigUpdate({ device: 'card3' }); // lands mid-start
        release();
        await starting;
        expect(instance.getState().pendingRestart).toBe(true);

        await instance.stop();
        await instance.start();
        expect(plugin.onInit).toHaveBeenCalledTimes(2);
        expect(plugin.onInit).toHaveBeenLastCalledWith(
            expect.objectContaining({ device: 'card3' }),
            undefined,
        );
        expect(instance.getState().pendingRestart).toBe(false);
    });
});

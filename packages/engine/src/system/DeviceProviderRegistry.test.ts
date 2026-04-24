import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Device } from '@media-router/shared-types';
import { DeviceProviderRegistry } from './DeviceProviderRegistry.js';

describe('DeviceProviderRegistry', () => {
    let registry: DeviceProviderRegistry;

    beforeEach(() => {
        registry = new DeviceProviderRegistry();
        vi.useFakeTimers();
    });

    afterEach(() => {
        registry.stopPolling();
        vi.useRealTimers();
    });

    it('registers and retrieves a provider by type', () => {
        const list = () => [{ name: 'a', label: 'A' } as Device];
        registry.register({ type: 'audio-source', list });
        expect(registry.getProvider('audio-source')?.list()).toEqual([{ name: 'a', label: 'A' }]);
        expect(registry.types()).toEqual(['audio-source']);
    });

    it('unregister stops polling and removes the provider', () => {
        const list = vi.fn(() => [] as Device[]);
        registry.register({ type: 'audio-source', list, pollMs: 100 });
        registry.startPolling();
        expect(list).toHaveBeenCalledTimes(1); // initial fire
        registry.unregister('audio-source');
        vi.advanceTimersByTime(500);
        expect(list).toHaveBeenCalledTimes(1); // no more calls after unregister
        expect(registry.getProvider('audio-source')).toBeUndefined();
    });

    it('replacing a provider for the same type warns and overrides', () => {
        const first = vi.fn(() => [{ name: 'a', label: 'A' } as Device]);
        const second = vi.fn(() => [{ name: 'b', label: 'B' } as Device]);
        registry.register({ type: 't', list: first });
        registry.register({ type: 't', list: second });
        expect(registry.getProvider('t')?.list()).toEqual([{ name: 'b', label: 'B' }]);
    });

    it('getDevices resolves via the provider', async () => {
        registry.register({
            type: 'video',
            list: async () => [{ name: '/dev/video0', label: 'Cam' }],
        });
        expect(await registry.getDevices('video')).toEqual([{ name: '/dev/video0', label: 'Cam' }]);
    });

    it('getDevices throws for unknown type', async () => {
        await expect(registry.getDevices('nope')).rejects.toThrow(/No device provider/);
    });

    it('polling emits deviceList only when the snapshot changes', async () => {
        let devices: Device[] = [{ name: 'a', label: 'A' }];
        const spy = vi.fn();
        registry.on('deviceList', spy);
        registry.register({ type: 'audio-source', list: () => devices, pollMs: 100 });
        registry.startPolling();

        // Initial fire flushes the first snapshot through the async list() handler.
        await vi.runOnlyPendingTimersAsync();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenLastCalledWith({ type: 'audio-source', devices });

        // No change → no emit.
        await vi.advanceTimersByTimeAsync(100);
        expect(spy).toHaveBeenCalledTimes(1);

        // Change → emit.
        devices = [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }];
        await vi.advanceTimersByTimeAsync(100);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenLastCalledWith({ type: 'audio-source', devices });
    });

    it('pollMs=0 opts out of polling; provider only serves getDevices', async () => {
        const list = vi.fn(() => [{ name: 'hdmi', label: 'HDMI' } as Device]);
        const spy = vi.fn();
        registry.on('deviceList', spy);
        registry.register({ type: 'drm-connector', list, pollMs: 0 });
        registry.startPolling();
        vi.advanceTimersByTime(10_000);
        expect(list).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();

        // getDevices still works on demand.
        expect(await registry.getDevices('drm-connector')).toEqual([{ name: 'hdmi', label: 'HDMI' }]);
        expect(list).toHaveBeenCalledTimes(1);
    });

    it('stopPolling clears timers and resetSnapshots forces next emit', async () => {
        const list = vi.fn(() => [{ name: 'a', label: 'A' } as Device]);
        const spy = vi.fn();
        registry.on('deviceList', spy);
        registry.register({ type: 't', list, pollMs: 100 });
        registry.startPolling();
        await vi.runOnlyPendingTimersAsync();
        expect(spy).toHaveBeenCalledTimes(1);

        registry.stopPolling();
        await vi.advanceTimersByTimeAsync(500);
        expect(spy).toHaveBeenCalledTimes(1); // no new emits after stop

        registry.resetSnapshots();
        registry.startPolling();
        await vi.runOnlyPendingTimersAsync();
        expect(spy).toHaveBeenCalledTimes(2); // re-emits after reset
    });

    it('register during active polling starts the new provider immediately', async () => {
        registry.startPolling();
        const list = vi.fn(() => [{ name: 'late', label: 'Late' } as Device]);
        const spy = vi.fn();
        registry.on('deviceList', spy);
        registry.register({ type: 'late-comer', list, pollMs: 100 });
        await vi.runOnlyPendingTimersAsync();
        expect(spy).toHaveBeenCalledWith({ type: 'late-comer', devices: [{ name: 'late', label: 'Late' }] });
    });

    it('a failing provider does not break the registry', async () => {
        const good = vi.fn(() => [{ name: 'a', label: 'A' } as Device]);
        const bad = vi.fn(() => {
            throw new Error('boom');
        });
        const spy = vi.fn();
        registry.on('deviceList', spy);
        registry.register({ type: 'good', list: good, pollMs: 100 });
        registry.register({ type: 'bad', list: bad, pollMs: 100 });
        registry.startPolling();
        await vi.runOnlyPendingTimersAsync();
        expect(spy).toHaveBeenCalledWith({ type: 'good', devices: [{ name: 'a', label: 'A' }] });
    });
});

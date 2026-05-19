import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeviceWatchdog, type DeviceWatchdogOptions } from './DeviceWatchdog.js';

function makeWatchdog(overrides: Partial<DeviceWatchdogOptions> = {}) {
    const present = { value: true };
    const hasDevice = vi.fn((name: string) => (name === 'absent' ? false : present.value));
    const onDisconnect = vi.fn(async () => {});
    const onReconnect = vi.fn(async () => {});
    const onHealthChange = vi.fn();
    const onClear = vi.fn();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Required<DeviceWatchdogOptions>['log'];

    const wd = new DeviceWatchdog({
        getDeviceName: () => 'mic-1',
        pipeWire: { hasDevice },
        onDisconnect,
        onReconnect,
        onHealthChange,
        onClear,
        log,
        pollMs: 100,
        ...overrides,
    });

    return { wd, hasDevice, onDisconnect, onReconnect, onHealthChange, onClear, present };
}

describe('DeviceWatchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does nothing when getDeviceName returns null', async () => {
        const { wd, hasDevice, onDisconnect } = makeWatchdog({ getDeviceName: () => null });
        wd.start();
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(500);
        expect(hasDevice).not.toHaveBeenCalled();
        expect(onDisconnect).not.toHaveBeenCalled();
        await wd.stop();
    });

    it('fires onDisconnect + health=error when the device disappears', async () => {
        const { wd, present, onDisconnect, onHealthChange, onClear } = makeWatchdog();
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(150);
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenCalledWith('error', 'Device disconnected');
        expect(onClear).toHaveBeenCalledOnce();
        expect(wd.isConnected()).toBe(false);
        await wd.stop();
    });

    it('only fires onDisconnect once across multiple ticks while still missing', async () => {
        const { wd, present, onDisconnect } = makeWatchdog();
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(500);
        expect(onDisconnect).toHaveBeenCalledOnce();
        await wd.stop();
    });

    it('fires onReconnect + health=ok when the device reappears', async () => {
        const { wd, present, onReconnect, onHealthChange } = makeWatchdog();
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(150);
        onHealthChange.mockClear();
        present.value = true;
        await vi.advanceTimersByTimeAsync(150);
        expect(onReconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenCalledWith('ok');
        expect(wd.isConnected()).toBe(true);
        await wd.stop();
    });

    it('stays disconnected when onReconnect throws, flips health to warning', async () => {
        const onReconnect = vi.fn(async () => {
            throw new Error('format probe failed');
        });
        const { wd, present, onHealthChange } = makeWatchdog({ onReconnect });
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(150);
        present.value = true;
        await vi.advanceTimersByTimeAsync(150);
        expect(wd.isConnected()).toBe(false);
        expect(onHealthChange).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('format probe failed'),
        );
        await wd.stop();
    });

    it('retries onReconnect on the next tick after a failed attempt', async () => {
        let calls = 0;
        const onReconnect = vi.fn(async () => {
            if (++calls === 1) throw new Error('not ready');
        });
        const { wd, present } = makeWatchdog({ onReconnect });
        wd.start();
        present.value = false;
        // Disconnect tick
        await vi.advanceTimersToNextTimerAsync();
        present.value = true;
        // First reconnect attempt — throws, stays disconnected
        await vi.advanceTimersToNextTimerAsync();
        expect(wd.isConnected()).toBe(false);
        // Second reconnect attempt — succeeds
        await vi.advanceTimersToNextTimerAsync();
        expect(wd.isConnected()).toBe(true);
        expect(onReconnect).toHaveBeenCalledTimes(2);
        await wd.stop();
    });

    it('swallows onDisconnect failures and stays in the disconnected state', async () => {
        const onDisconnect = vi.fn(async () => {
            throw new Error('teardown failed');
        });
        const { wd, present } = makeWatchdog({ onDisconnect });
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(150);
        expect(wd.isConnected()).toBe(false);
        await wd.stop();
    });

    it('skips overlapping ticks while a previous one is still running', async () => {
        // Hold onReconnect open until we tell it to resolve, then verify only
        // one onReconnect call fires even though several ticks elapse.
        let release: (() => void) | null = null;
        const onReconnect = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const { wd, present } = makeWatchdog({ onReconnect });
        wd.start();
        present.value = false;
        await vi.advanceTimersByTimeAsync(150);
        present.value = true;
        await vi.advanceTimersByTimeAsync(150);
        await vi.advanceTimersByTimeAsync(500);
        expect(onReconnect).toHaveBeenCalledOnce();
        release?.();
        await vi.advanceTimersByTimeAsync(0);
        await wd.stop();
    });

    it('start() is idempotent — calling twice does not spawn two timers', async () => {
        const { wd, hasDevice } = makeWatchdog();
        wd.start();
        wd.start();
        await vi.advanceTimersByTimeAsync(100);
        // Two timers would produce two hasDevice calls per tick
        expect(hasDevice).toHaveBeenCalledTimes(1);
        await wd.stop();
    });

    it('respects initiallyConnected=false — first tick with present device triggers reconnect', async () => {
        const { wd, onReconnect, onHealthChange } = makeWatchdog();
        wd.start(false);
        await vi.advanceTimersByTimeAsync(150);
        expect(onReconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenCalledWith('ok');
        await wd.stop();
    });

    it('stop() awaits an in-flight tick before returning', async () => {
        let release: (() => void) | null = null;
        const onReconnect = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const { wd, present } = makeWatchdog({ onReconnect });
        wd.start(false);
        await vi.advanceTimersByTimeAsync(150);
        // Tick is in-flight (onReconnect hasn't resolved). Call stop and
        // verify it doesn't resolve until release() fires.
        let stopResolved = false;
        const stopPromise = wd.stop().then(() => {
            stopResolved = true;
        });
        // Synchronous microtask flush — stop shouldn't have resolved yet
        await Promise.resolve();
        expect(stopResolved).toBe(false);
        release?.();
        await stopPromise;
        expect(stopResolved).toBe(true);
        // Suppress unused-var lint
        void present;
    });
});

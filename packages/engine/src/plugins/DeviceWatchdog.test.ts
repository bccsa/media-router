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

/** A watchdog on a stub PipeWire whose daemon (`cookie`) and answer (`up`) the test sets. */
function lossWatchdog(overrides: Partial<DeviceWatchdogOptions> = {}) {
    const pw = { present: true, up: true, cookie: 'a1' as string | null };
    const made = makeWatchdog({
        pipeWire: {
            hasDevice: () => pw.up && pw.present,
            daemonInstance: () => (pw.up ? pw.cookie : null),
            isAvailable: () => pw.up,
        },
        ...overrides,
    });
    const log = (made.wd as any).log;
    return { ...made, pw, log };
}

describe('DeviceWatchdog: a lost PipeWire stream (B-195)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('a PipeWire restart under a listed device tears down with a warning and rebuilds next tick', async () => {
        const { wd, pw, onDisconnect, onReconnect, onHealthChange } = lossWatchdog();
        wd.start();
        await wd.tick();
        expect(onDisconnect).not.toHaveBeenCalled();
        // The field case: the device never left the list, the daemon under it changed.
        pw.cookie = 'b2';
        await wd.tick();
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenLastCalledWith(
            'warning',
            'PipeWire restarted — rebuilding the stream once PipeWire and the device are back',
        );
        expect(onHealthChange).not.toHaveBeenCalledWith('error', expect.anything());
        expect(wd.isConnected()).toBe(false);
        await wd.tick();
        expect(onReconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenLastCalledWith('ok');
        // Rebuilt on the new daemon: nothing more.
        await wd.tick();
        await wd.tick();
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onReconnect).toHaveBeenCalledOnce();
        await wd.stop();
    });

    it("a poll between PipeWire's return and its device's is the restart, not an unplug", async () => {
        const { wd, pw, onDisconnect, onReconnect, onHealthChange } = lossWatchdog();
        wd.start();
        await wd.tick();
        pw.cookie = 'b2';
        pw.present = false; // WirePlumber has not made the device node again yet
        await wd.tick();
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).not.toHaveBeenCalledWith('error', 'Device disconnected');
        expect(onHealthChange).toHaveBeenLastCalledWith(
            'warning',
            'PipeWire restarted — rebuilding the stream once PipeWire and the device are back',
        );
        await wd.tick();
        expect(onReconnect).not.toHaveBeenCalled();
        pw.present = true;
        await wd.tick();
        expect(onReconnect).toHaveBeenCalledOnce();
        await wd.stop();
    });

    it('an unknown daemon is never a restart: the first one known is adopted', async () => {
        const { wd, pw, onDisconnect } = lossWatchdog();
        pw.cookie = null;
        wd.start();
        pw.cookie = 'a1';
        await wd.tick();
        expect(onDisconnect).not.toHaveBeenCalled();
        pw.cookie = 'b2';
        await wd.tick();
        expect(onDisconnect).toHaveBeenCalledOnce();
        await wd.stop();
    });

    it('adopt() takes the daemon a runner-internal restart came up on', async () => {
        const { wd, pw, onDisconnect } = lossWatchdog();
        wd.start();
        pw.cookie = 'b2';
        await wd.adopt(); // PLAYING on the new daemon
        await wd.tick();
        expect(onDisconnect).not.toHaveBeenCalled();
        await wd.stop();
    });

    it('lose() tears down once with its cause and rebuilds only when the device is listed', async () => {
        const { wd, pw, onDisconnect, onReconnect, onHealthChange, onClear } = lossWatchdog();
        wd.start();
        await wd.lose('No audio from the capture for 4 s');
        await wd.lose('PipeWire stream failed (Disconnected)');
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onClear).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenLastCalledWith(
            'warning',
            'No audio from the capture for 4 s — rebuilding the stream once PipeWire and the device are back',
        );
        pw.present = false;
        await wd.tick();
        await wd.tick();
        expect(onReconnect).not.toHaveBeenCalled();
        pw.present = true;
        await wd.tick();
        expect(onReconnect).toHaveBeenCalledOnce();
        expect(wd.isConnected()).toBe(true);
        await wd.stop();
    });

    it('losses in a run wait 0, 2, 4 s before their rebuild; a stable minute starts a new run', async () => {
        const { wd, onReconnect, onHealthChange } = lossWatchdog();
        wd.start();
        const lossThenRebuild = async (waitMs: number) => {
            const before = onReconnect.mock.calls.length;
            await wd.lose('No audio from the capture for 4 s');
            if (waitMs > 0) {
                await vi.advanceTimersByTimeAsync(waitMs - 1);
                await wd.tick();
                expect(onReconnect).toHaveBeenCalledTimes(before);
                await vi.advanceTimersByTimeAsync(1);
            }
            await wd.tick();
            expect(onReconnect).toHaveBeenCalledTimes(before + 1);
        };
        await lossThenRebuild(0);
        await vi.advanceTimersByTimeAsync(10_000);
        await lossThenRebuild(2_000);
        expect(onHealthChange).toHaveBeenCalledWith(
            'warning',
            'No audio from the capture for 4 s — rebuilding the stream in 2 s',
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await lossThenRebuild(4_000);
        await vi.advanceTimersByTimeAsync(60_000);
        await lossThenRebuild(0);
        await wd.stop();
    });

    it('PipeWire not answering is no unplug; a loss meanwhile names it and waits without retries or logs', async () => {
        const { wd, pw, log, onDisconnect, onReconnect, onHealthChange } = lossWatchdog();
        wd.start();
        await wd.tick(); // the daemon the stream started on is known
        pw.up = false;
        await wd.tick();
        expect(onDisconnect).not.toHaveBeenCalled();
        expect(wd.isConnected()).toBe(true);
        await wd.lose('No audio from the capture for 4 s');
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenLastCalledWith(
            'warning',
            'PipeWire is not answering — rebuilding the stream once PipeWire and the device are back',
        );
        const lines = log.warn.mock.calls.length + log.info.mock.calls.length;
        for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(100); // 30 polls down
        expect(onReconnect).not.toHaveBeenCalled();
        expect(log.warn.mock.calls.length + log.info.mock.calls.length).toBe(lines);
        // Back, on a new daemon: one rebuild, one line.
        pw.up = true;
        pw.cookie = 'b2';
        await vi.advanceTimersByTimeAsync(100);
        expect(onReconnect).toHaveBeenCalledOnce();
        expect(log.info).toHaveBeenLastCalledWith(
            { cause: 'PipeWire restarted' },
            'PipeWire stream rebuilt',
        );
        await wd.stop();
    });

    it('a restart found while the stream waits renames the cause, once', async () => {
        const { wd, pw, onHealthChange } = lossWatchdog();
        wd.start();
        await wd.lose('No audio from the capture for 4 s');
        pw.present = false; // the device not back yet
        pw.cookie = 'b2';
        onHealthChange.mockClear();
        await wd.tick();
        await wd.tick();
        expect(onHealthChange).toHaveBeenCalledOnce();
        expect(onHealthChange).toHaveBeenCalledWith(
            'warning',
            'PipeWire restarted — rebuilding the stream once PipeWire and the device are back',
        );
        await wd.stop();
    });

    it('lose() before start(), after stop(), or with the device never seen does nothing', async () => {
        const { wd, onDisconnect } = lossWatchdog();
        await wd.lose('x');
        wd.start(false);
        await wd.lose('x');
        await wd.stop();
        await wd.lose('x');
        expect(onDisconnect).not.toHaveBeenCalled();
    });

    it('lose() waits for an in-flight rebuild, then tears the rebuilt stream down', async () => {
        let release: (() => void) | null = null;
        const onReconnect = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const { wd, onDisconnect } = lossWatchdog({ onReconnect });
        wd.start(false);
        await vi.advanceTimersByTimeAsync(100); // reconnect in flight
        const losing = wd.lose('PipeWire stream failed (Disconnected)');
        await vi.advanceTimersByTimeAsync(0);
        expect(onDisconnect).not.toHaveBeenCalled();
        release!();
        await losing;
        expect(onDisconnect).toHaveBeenCalledOnce();
        expect(wd.isConnected()).toBe(false);
        await wd.stop();
    });
});

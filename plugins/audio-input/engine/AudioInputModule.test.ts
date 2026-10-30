import { describe, it, expect, vi } from 'vitest';
import { ModuleInstance } from '@media-router/engine';
import { AudioInputModule } from './AudioInputModule.js';

/**
 * Helper that drives the device watchdog directly rather than waiting for
 * its 2-second `setInterval` to fire. Fake timers don't interleave cleanly
 * with the multi-`await` chain inside `onDeviceReconnected`, so we just
 * invoke the watchdog's `tick()` method.
 */
async function tickWatchdog(module: AudioInputModule): Promise<void> {
    await (module as any).deviceWatchdog?.tick();
}

function createMockPipeWire(opts: { devicePresent: boolean; channels?: number; sampleRate?: number } = { devicePresent: true, channels: 1, sampleRate: 48000 }) {
    let present = opts.devicePresent;
    const unloadedModuleIds: number[] = [];
    let moduleIdCounter = 100;

    return {
        // mutable so a test can flip presence between watchdog ticks
        setPresent(v: boolean) {
            present = v;
        },
        unloadedModuleIds,
        hasDevice: vi.fn((_name: string) => present),
        getDeviceInfo: vi.fn((_name: string) =>
            present ? { channels: opts.channels, sampleRate: opts.sampleRate } : null,
        ),
        listDevices: vi.fn(() => []),
        loadRemapSource: vi.fn(async () => ++moduleIdCounter),
        waitForSource: vi.fn(async () => true),
        setSourceVolume: vi.fn(async () => {}),
        unloadModule: vi.fn(async (id: number) => {
            unloadedModuleIds.push(id);
        }),
        releaseAll: vi.fn(async () => {}),
    };
}

function createModule(devicePresent: boolean, configOverrides: Record<string, unknown> = {}) {
    const module = new AudioInputModule();
    // Skip the VU GStreamer child process — we're testing the watchdog/PipeWire
    // glue, not the GStreamer fork. `null` makes GstPluginBase.onStart a no-op.
    (module as any).buildPipeline = () => null;
    const pw = createMockPipeWire({ devicePresent, channels: 1, sampleRate: 48000 });
    const services = {
        pipeWire: pw as any,
        mediaRouter: {} as any,
        processManager: {} as any,
        deviceProviders: {} as any,
        instanceId: 'mic-test-001',
    };
    const config = {
        device: 'alsa_input.usb-Shure_MVX2U',
        channels: 1,
        sampleRate: 48000,
        volume: 80,
        audioEnabled: true,
        ...configOverrides,
    };
    return { module, pw, services, config };
}

describe('AudioInputModule hot-plug recovery', () => {
    it('does not throw when device is absent at start', async () => {
        const { module, services, config } = createModule(false);
        await module.onInit(config, services);
        await expect(module.onStart()).resolves.toBeUndefined();
        await module.onStop();
    });

    it('sets warning health and skips remap-source load when device absent', async () => {
        const { module, pw, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSource).not.toHaveBeenCalled();
        const state = module.getState();
        expect(state.health).toBe('warning');
        expect(state.error).toMatch(/not connected/);
        await module.onStop();
    });

    it('starts the watchdog when device is absent so hot-plug can recover', async () => {
        const { module, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        // The watchdog interval is the only thing that detects hot-plug.
        // Before the fix, onStart threw and the watchdog never started —
        // assert that it's running now.
        expect((module as any).deviceWatchdog).not.toBeNull();
        await module.onStop();
    });

    it('builds remap-source when device returns via watchdog tick', async () => {
        const { module, pw, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSource).not.toHaveBeenCalled();

        pw.setPresent(true);
        await tickWatchdog(module);

        expect(pw.loadRemapSource).toHaveBeenCalledTimes(1);
        expect(pw.loadRemapSource).toHaveBeenCalledWith(
            'mic-test-001',
            'alsa_input.usb-Shure_MVX2U',
            1,
            48000,
            'mic-test-001',
        );
        await module.onStop();
    });

    it('unloads stale remap-source on device disconnect', async () => {
        const { module, pw, services, config } = createModule(true);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSource).toHaveBeenCalledTimes(1);
        const remapId = await pw.loadRemapSource.mock.results[0].value;

        pw.setPresent(false);
        await tickWatchdog(module);

        expect(pw.unloadModule).toHaveBeenCalledWith(remapId);
        expect(pw.unloadedModuleIds).toContain(remapId);
        await module.onStop();
    });

    it('loads a fresh remap-source after disconnect/reconnect cycle', async () => {
        const { module, pw, services, config } = createModule(true);
        await module.onInit(config, services);
        await module.onStart();

        pw.setPresent(false);
        await tickWatchdog(module);
        pw.setPresent(true);
        await tickWatchdog(module);

        expect(pw.loadRemapSource).toHaveBeenCalledTimes(2);
        await module.onStop();
    });
});

describe('AudioInputModule: a restart applies a re-picked device (B-191)', () => {
    const OLD = 'alsa_input.usb-Shure_MVX2U';
    const NEW = 'alsa_input.usb-Solid_State_Logic_SSL_2-00.HiFi__Mic1__source';

    /** The module under the engine's ModuleInstance on a graph of `present` devices. `repick`
     *  is a settings patch, then what Restart does to the instance. */
    function underEngine(present: Set<string>) {
        const { module, pw, services, config } = createModule(true);
        pw.hasDevice.mockImplementation((name: string) => present.has(name));
        pw.getDeviceInfo.mockImplementation((name: string) =>
            present.has(name) ? { channels: 1, sampleRate: 48000 } : null,
        );
        // The PipeWire latency poll reads the real graph: not wanted here.
        vi.spyOn((module as any).timing, 'watchPipeWire').mockImplementation(() => {});
        const instance = new ModuleInstance('mic-test-001', 'audio-input', module, config, {
            ...services,
            mediaRouter: { releaseAllBusChannelsFor: vi.fn() } as any,
            processManager: { releaseAll: vi.fn(async () => {}) } as any,
        });
        const repick = async (device: string) => {
            await instance.applyConfigUpdate({ device });
            await instance.stop();
            await instance.start();
        };
        /** The device of each remap-source loaded so far. */
        const remapped = () => pw.loadRemapSource.mock.calls.map((c: unknown[]) => c[1]);
        return { module: module as any, instance, repick, remapped };
    }

    it('a running input remaps and watches the re-picked device after Restart', async () => {
        const { module, instance, repick, remapped } = underEngine(new Set([OLD, NEW]));
        await instance.start();
        await repick(NEW);
        expect(remapped()).toEqual([OLD, NEW]);
        expect(module.getWatchedDeviceName()).toBe(NEW);
        await instance.stop();
    });

    it('an input waiting for hot-plug waits for the re-picked device after Restart', async () => {
        const present = new Set<string>();
        const { module, instance, repick, remapped } = underEngine(present);
        await instance.start();
        expect(module.getState().error).toBe(
            `Audio device "${OLD}" not connected — waiting for hot-plug`,
        );
        await repick(NEW);
        expect(module.getState().error).toBe(
            `Audio device "${NEW}" not connected — waiting for hot-plug`,
        );
        present.add(OLD);
        await tickWatchdog(module);
        expect(remapped()).toEqual([]);
        present.add(NEW);
        await tickWatchdog(module);
        expect(remapped()).toEqual([NEW]);
        await instance.stop();
    });
});

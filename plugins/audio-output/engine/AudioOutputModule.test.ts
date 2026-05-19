import { describe, it, expect, vi } from 'vitest';
import { AudioOutputModule } from './AudioOutputModule.js';

async function tickWatchdog(module: AudioOutputModule): Promise<void> {
    await (module as any).deviceWatchdog?.tick();
}

function createMockPipeWire(opts: { devicePresent: boolean; channels?: number; sampleRate?: number } = { devicePresent: true, channels: 2, sampleRate: 48000 }) {
    let present = opts.devicePresent;
    const unloadedModuleIds: number[] = [];
    let moduleIdCounter = 100;

    return {
        setPresent(v: boolean) {
            present = v;
        },
        unloadedModuleIds,
        hasDevice: vi.fn((_name: string) => present),
        getDeviceInfo: vi.fn((_name: string) =>
            present ? { channels: opts.channels, sampleRate: opts.sampleRate } : null,
        ),
        listDevices: vi.fn(() => []),
        loadRemapSink: vi.fn(async () => ++moduleIdCounter),
        waitForSink: vi.fn(async () => true),
        setSinkVolume: vi.fn(async () => {}),
        unloadModule: vi.fn(async (id: number) => {
            unloadedModuleIds.push(id);
        }),
        releaseAll: vi.fn(async () => {}),
    };
}

function createModule(devicePresent: boolean, configOverrides: Record<string, unknown> = {}) {
    const module = new AudioOutputModule();
    // Skip the VU GStreamer child process — we're testing the watchdog/PipeWire
    // glue, not the GStreamer fork. `null` makes GstPluginBase.onStart a no-op.
    (module as any).buildPipeline = () => null;
    const pw = createMockPipeWire({ devicePresent, channels: 2, sampleRate: 48000 });
    const services = {
        pipeWire: pw as any,
        mediaRouter: {} as any,
        processManager: {} as any,
        deviceProviders: {} as any,
        instanceId: 'spk-test-001',
    };
    const config = {
        device: 'alsa_output.usb-Generic_USB_Audio',
        channels: 2,
        sampleRate: 48000,
        volume: 80,
        audioEnabled: true,
        ...configOverrides,
    };
    return { module, pw, services, config };
}

describe('AudioOutputModule hot-plug recovery', () => {
    it('does not throw when device is absent at start', async () => {
        const { module, services, config } = createModule(false);
        await module.onInit(config, services);
        await expect(module.onStart()).resolves.toBeUndefined();
        await module.onStop();
    });

    it('sets warning health and skips remap-sink load when device absent', async () => {
        const { module, pw, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSink).not.toHaveBeenCalled();
        const state = module.getState();
        expect(state.health).toBe('warning');
        expect(state.error).toMatch(/not connected/);
        await module.onStop();
    });

    it('starts the watchdog when device is absent so hot-plug can recover', async () => {
        const { module, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        expect((module as any).deviceWatchdog).not.toBeNull();
        await module.onStop();
    });

    it('builds remap-sink when device returns via watchdog tick', async () => {
        const { module, pw, services, config } = createModule(false);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSink).not.toHaveBeenCalled();

        pw.setPresent(true);
        await tickWatchdog(module);

        expect(pw.loadRemapSink).toHaveBeenCalledTimes(1);
        expect(pw.loadRemapSink).toHaveBeenCalledWith(
            'spk-test-001',
            'alsa_output.usb-Generic_USB_Audio',
            2,
            48000,
            'spk-test-001',
        );
        await module.onStop();
    });

    it('unloads stale remap-sink on device disconnect', async () => {
        const { module, pw, services, config } = createModule(true);
        await module.onInit(config, services);
        await module.onStart();
        expect(pw.loadRemapSink).toHaveBeenCalledTimes(1);
        const sinkId = await pw.loadRemapSink.mock.results[0].value;

        pw.setPresent(false);
        await tickWatchdog(module);

        expect(pw.unloadModule).toHaveBeenCalledWith(sinkId);
        expect(pw.unloadedModuleIds).toContain(sinkId);
        await module.onStop();
    });

    it('loads a fresh remap-sink after disconnect/reconnect cycle', async () => {
        const { module, pw, services, config } = createModule(true);
        await module.onInit(config, services);
        await module.onStart();

        pw.setPresent(false);
        await tickWatchdog(module);
        pw.setPresent(true);
        await tickWatchdog(module);

        expect(pw.loadRemapSink).toHaveBeenCalledTimes(2);
        await module.onStop();
    });
});

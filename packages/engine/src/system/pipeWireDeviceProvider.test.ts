import { describe, it, expect, vi } from 'vitest';
import type { EngineServices } from '../plugins/PluginModule.js';
import type { DeviceProvider } from './DeviceProviderRegistry.js';
import { registerPipeWireDeviceProvider } from './pipeWireDeviceProvider.js';

function makeServices(devices: Array<Record<string, unknown>>) {
    let registered: DeviceProvider | undefined;
    const register = vi.fn((p: DeviceProvider) => {
        registered = p;
    });
    const services = {
        pipeWire: {
            listDevices: vi.fn(() => devices),
        },
        deviceProviders: { register },
    } as unknown as EngineServices;
    return { services, register, getRegistered: () => registered };
}

describe('registerPipeWireDeviceProvider', () => {
    it('registers a provider under the given type', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        expect(register).toHaveBeenCalledTimes(1);
        expect(register.mock.calls[0][0].type).toBe('audio-source');
    });

    it('forwards pollMs when provided', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, {
            type: 'audio-sink',
            direction: 'sink',
            pollMs: 500,
        });
        expect(register.mock.calls[0][0].pollMs).toBe(500);
    });

    it('omits pollMs when not provided so the registry default applies', () => {
        const { services, register } = makeServices([]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        expect(register.mock.calls[0][0].pollMs).toBeUndefined();
    });

    it('list() filters PipeWire devices to the requested direction', () => {
        const { services, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Built-in Mic', channels: 2, sampleRate: 48000 },
            { name: 'spk', direction: 'sink', description: 'Speakers', channels: 2, sampleRate: 48000 },
            { name: 'usb', direction: 'source', description: 'USB Mic', channels: 1, sampleRate: 44100 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ name: string }>;
        expect(list.map((d) => d.name)).toEqual(['mic', 'usb']);
    });

    it('formats labels with channel and sample-rate metadata', () => {
        const { services, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Built-in Mic', channels: 2, sampleRate: 48000 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ label: string; meta: Record<string, unknown> }>;
        expect(list[0].label).toBe('Built-in Mic (2ch, 48000Hz)');
        expect(list[0].meta).toEqual({ direction: 'source', channels: 2, sampleRate: 48000 });
    });

    it('falls back to the device name when description is missing', () => {
        const { services, getRegistered } = makeServices([
            { name: 'unnamed', direction: 'source', description: '', channels: 1, sampleRate: 44100 },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = getRegistered()!.list() as Array<{ label: string }>;
        expect(list[0].label).toBe('unnamed (1ch, 44100Hz)');
    });

    it('renders `?` placeholders when channel/sampleRate are missing', () => {
        const { services, getRegistered } = makeServices([
            { name: 'partial', direction: 'sink', description: 'Partial' },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        const list = getRegistered()!.list() as Array<{ label: string }>;
        expect(list[0].label).toBe('Partial (?ch, ?Hz)');
    });
});

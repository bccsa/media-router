import { describe, it, expect, vi } from 'vitest';
import type { EngineServices } from '../plugins/PluginModule.js';
import type { DeviceProvider } from './DeviceProviderRegistry.js';
import { registerPipeWireDeviceProvider } from './pipeWireDeviceProvider.js';

/** `stale` set: PipeWire gives no answer, and `devices` is its last (null: it never answered). */
function makeServices(
    devices: Array<Record<string, unknown>> | null,
    stale: { reason: string; since: number } | null = null,
) {
    let registered: DeviceProvider | undefined;
    const register = vi.fn((p: DeviceProvider) => {
        registered = p;
    });
    const normalizeSinkVolumes = vi.fn();
    const services = {
        pipeWire: {
            deviceListing: vi.fn(async () => ({ devices, stale })),
            normalizeSinkVolumes,
        },
        deviceProviders: { register },
    } as unknown as EngineServices;
    return { services, register, normalizeSinkVolumes, getRegistered: () => registered };
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

    it('list() filters PipeWire devices to the requested direction', async () => {
        const { services, getRegistered } = makeServices([
            {
                name: 'mic',
                direction: 'source',
                description: 'Built-in Mic',
                channels: 2,
                sampleRate: 48000,
            },
            {
                name: 'spk',
                direction: 'sink',
                description: 'Speakers',
                channels: 2,
                sampleRate: 48000,
            },
            {
                name: 'usb',
                direction: 'source',
                description: 'USB Mic',
                channels: 1,
                sampleRate: 44100,
            },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = (await getRegistered()!.list()) as Array<{ name: string }>;
        expect(list.map((d) => d.name)).toEqual(['mic', 'usb']);
    });

    it('formats labels with channel and sample-rate metadata', async () => {
        const { services, getRegistered } = makeServices([
            {
                name: 'mic',
                direction: 'source',
                description: 'Built-in Mic',
                channels: 2,
                sampleRate: 48000,
            },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = (await getRegistered()!.list()) as Array<{
            label: string;
            meta: Record<string, unknown>;
        }>;
        expect(list[0].label).toBe('Built-in Mic (2ch, 48000Hz)');
        expect(list[0].meta).toEqual({ direction: 'source', channels: 2, sampleRate: 48000 });
    });

    it('falls back to the device name when description is missing', async () => {
        const { services, getRegistered } = makeServices([
            {
                name: 'unnamed',
                direction: 'source',
                description: '',
                channels: 1,
                sampleRate: 44100,
            },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        const list = (await getRegistered()!.list()) as Array<{ label: string }>;
        expect(list[0].label).toBe('unnamed (1ch, 44100Hz)');
    });

    it('normalizes sink volumes on every poll, with the unfiltered device list', async () => {
        const devices = [
            { name: 'spk', direction: 'sink', description: 'Speakers', volumes: [26214, 26214] },
            { name: 'mic', direction: 'source', description: 'Mic', volumes: [65536] },
        ];
        const { services, normalizeSinkVolumes, getRegistered } = makeServices(devices);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        await getRegistered()!.list();
        expect(normalizeSinkVolumes).toHaveBeenCalledWith(devices);
    });

    it('does not normalize from the source provider — sinks are corrected once, not twice', async () => {
        const { services, normalizeSinkVolumes, getRegistered } = makeServices([
            { name: 'mic', direction: 'source', description: 'Mic' },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-source', direction: 'source' });
        await getRegistered()!.list();
        expect(normalizeSinkVolumes).not.toHaveBeenCalled();
    });

    it('keeps volume out of `meta` so the registry diff does not spam deviceList', async () => {
        const { services, getRegistered } = makeServices([
            {
                name: 'spk',
                direction: 'sink',
                description: 'Speakers',
                channels: 2,
                sampleRate: 48000,
                volumes: [26214, 26214],
            },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        const list = (await getRegistered()!.list()) as Array<{ meta: Record<string, unknown> }>;
        expect(list[0].meta).toEqual({ direction: 'sink', channels: 2, sampleRate: 48000 });
    });

    it('renders `?` placeholders when channel/sampleRate are missing', async () => {
        const { services, getRegistered } = makeServices([
            { name: 'partial', direction: 'sink', description: 'Partial' },
        ]);
        registerPipeWireDeviceProvider(services, { type: 'audio-sink', direction: 'sink' });
        const list = (await getRegistered()!.list()) as Array<{ label: string }>;
        expect(list[0].label).toBe('Partial (?ch, ?Hz)');
    });
});

describe('registerPipeWireDeviceProvider while PipeWire gives no answer (B-207)', () => {
    const SINCE = Date.parse('2026-11-03T09:01:00.840Z');
    const hung = { reason: 'PipeWire not answering', since: SINCE };
    const mark = { reason: 'PipeWire not answering', since: '2026-11-03T09:01:00Z' };
    const MIC = {
        name: 'mic',
        direction: 'source',
        description: 'USB Mic',
        channels: 1,
        sampleRate: 48000,
    };
    const SPK = {
        name: 'spk',
        direction: 'sink',
        description: 'Speakers',
        channels: 2,
        volumes: [26214],
    };

    async function listed(
        devices: Array<Record<string, unknown>> | null,
        direction: 'source' | 'sink',
        stale = hung,
    ) {
        const made = makeServices(devices, stale);
        registerPipeWireDeviceProvider(made.services, { type: `audio-${direction}`, direction });
        return { list: await made.getRegistered()!.list(), ...made };
    }

    it('serves its last list, each device marked with why and since when, in its label too', async () => {
        const { list } = await listed([MIC, SPK], 'source');
        expect(list).toEqual([
            {
                name: 'mic',
                label: 'USB Mic (1ch, 48000Hz) — PipeWire not answering since 2026-11-03T09:01:00Z',
                meta: { direction: 'source', channels: 1, sampleRate: 48000, stale: mark },
            },
        ]);
    });

    it('PipeWire not running reads so', async () => {
        const { list } = await listed([MIC], 'source', {
            reason: 'PipeWire not running',
            since: SINCE,
        });
        expect(list[0].label).toBe(
            'USB Mic (1ch, 48000Hz) — PipeWire not running since 2026-11-03T09:01:00Z',
        );
    });

    it('never answered: one nameless entry saying no answer, never an empty list', async () => {
        const { list } = await listed(null, 'source');
        expect(list).toEqual([
            {
                name: '',
                label: 'No answer: PipeWire not answering since 2026-11-03T09:01:00Z',
                meta: { stale: mark },
            },
        ]);
    });

    it('none of its kind in the last answer: one nameless entry saying so', async () => {
        const { list } = await listed([SPK], 'source');
        expect(list).toEqual([
            {
                name: '',
                label: "No device in PipeWire's last list — PipeWire not answering since 2026-11-03T09:01:00Z",
                meta: { stale: mark },
            },
        ]);
    });

    it('sets no sink volume from a stale list', async () => {
        const { normalizeSinkVolumes } = await listed([SPK], 'sink');
        expect(normalizeSinkVolumes).not.toHaveBeenCalled();
    });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
    aes67Discovery,
    discoveredStreamDevices,
    registerAes67StreamDeviceProvider,
    streamId,
    AES67_STREAM_DEVICE_TYPE,
} from './sapDiscovery.js';

const stream = (
    over: Partial<{ key: string; name: string; address: string; port: number }> = {},
) => ({
    key: 'k1',
    name: 'Studio A',
    address: '239.69.0.1',
    port: 5004,
    encoding: 'L24',
    channels: 2,
    ...over,
});

describe('aes67Discovery', () => {
    beforeEach(() => {
        aes67Discovery.clear('in-1');
        aes67Discovery.clear('in-2');
    });

    it('is empty with no listeners, and says so distinctly', () => {
        // "No streams" and "nothing is listening" are different states: the
        // second is what an operator sees before adding an AES67 input.
        expect(aes67Discovery.list()).toEqual([]);
        expect(aes67Discovery.hasListeners()).toBe(false);
    });

    it('publishes a listener snapshot', () => {
        aes67Discovery.publish('in-1', [stream()]);
        expect(aes67Discovery.hasListeners()).toBe(true);
        expect(aes67Discovery.list().map((s) => s.name)).toEqual(['Studio A']);
    });

    it('REPLACES a listener snapshot rather than merging into it', () => {
        // The sidecar emits whole snapshots so a vanished session leaves the
        // picker on the next update; merging would leave a phantom entry.
        aes67Discovery.publish('in-1', [
            stream(),
            stream({ key: 'k2', name: 'Studio B', address: '239.69.0.2' }),
        ]);
        aes67Discovery.publish('in-1', [stream()]);
        expect(aes67Discovery.list()).toHaveLength(1);
    });

    it('merges across listeners and deduplicates by address:port', () => {
        // Two inputs on the same LAN see the same announcements; the picker
        // must show one entry per stream, not one per listener.
        aes67Discovery.publish('in-1', [stream()]);
        aes67Discovery.publish('in-2', [
            stream({ key: 'other-key' }),
            stream({ key: 'k3', name: 'Studio C', address: '239.69.0.3' }),
        ]);
        expect(aes67Discovery.list().map((s) => streamId(s))).toEqual([
            '239.69.0.1:5004',
            '239.69.0.3:5004',
        ]);
    });

    it("drops a stopped listener's streams", () => {
        aes67Discovery.publish('in-1', [stream()]);
        aes67Discovery.clear('in-1');
        expect(aes67Discovery.list()).toEqual([]);
        expect(aes67Discovery.hasListeners()).toBe(false);
    });

    it('ignores entries with no address or port', () => {
        aes67Discovery.publish('in-1', [stream(), { key: 'bad', name: 'x', address: '', port: 0 }]);
        expect(aes67Discovery.list()).toHaveLength(1);
    });

    it('finds a stream by its stored picker value', () => {
        aes67Discovery.publish('in-1', [stream()]);
        expect(aes67Discovery.find('239.69.0.1:5004')?.name).toBe('Studio A');
        expect(aes67Discovery.find('239.69.9.9:5004')).toBeUndefined();
    });
});

describe('discoveredStreamDevices', () => {
    beforeEach(() => aes67Discovery.clear('in-1'));

    it('stores address:port and labels with the format, so the choice is informed', () => {
        aes67Discovery.publish('in-1', [stream()]);
        expect(discoveredStreamDevices()).toEqual([
            {
                name: '239.69.0.1:5004',
                label: 'Studio A — 239.69.0.1:5004 (L24 2ch)',
                meta: expect.objectContaining({ address: '239.69.0.1', port: 5004 }),
            },
        ]);
    });

    it('labels a stream whose announcement omitted the format', () => {
        aes67Discovery.publish('in-1', [
            { key: 'k', name: 'Bare', address: '239.69.0.5', port: 5004 },
        ]);
        expect(discoveredStreamDevices()[0].label).toBe('Bare — 239.69.0.5:5004');
    });
});

describe('registerAes67StreamDeviceProvider', () => {
    it('registers once and stays idempotent across module instances', () => {
        const providers = new Map<string, unknown>();
        const services = {
            deviceProviders: {
                getProvider: (t: string) => providers.get(t),
                register: (p: { type: string }) => providers.set(p.type, p),
            },
        } as never;
        registerAes67StreamDeviceProvider(services);
        registerAes67StreamDeviceProvider(services);
        expect(providers.size).toBe(1);
        expect(providers.has(AES67_STREAM_DEVICE_TYPE)).toBe(true);
    });
});

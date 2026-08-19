import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import {
    interfaceAddress,
    listNetworkInterfaces,
    registerNetworkInterfaceDeviceProvider,
    NETWORK_INTERFACE_DEVICE_TYPE,
} from './networkInterfaceProvider.js';

vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
const mockNics = vi.mocked(os.networkInterfaces);

beforeEach(() => mockNics.mockReset());

describe('listNetworkInterfaces', () => {
    it('returns one Device per non-internal interface, labelled with its IPv4', () => {
        mockNics.mockReturnValue({
            lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
            eth0: [
                { address: 'fe80::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
                { address: '192.168.1.10', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
            ],
        });
        const devices = listNetworkInterfaces();
        expect(devices).toHaveLength(1);
        expect(devices[0]).toMatchObject({ name: 'eth0', label: 'eth0 (192.168.1.10)' });
        expect(devices[0].meta).toMatchObject({ address: '192.168.1.10' });
    });

    it('labels with the bare name when an interface has no IPv4', () => {
        mockNics.mockReturnValue({
            tun0: [{ address: 'fe80::2', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo],
        });
        expect(listNetworkInterfaces()[0]).toMatchObject({ name: 'tun0', label: 'tun0' });
    });
});

describe('interfaceAddress', () => {
    // The translation between what the picker stores (an interface NAME, which
    // is what GStreamer's multicast-iface wants) and what a raw socket API
    // takes (an address — e.g. a SAP announcement's source, or a join).
    it('resolves a NIC name to its external IPv4', () => {
        mockNics.mockReturnValue({
            eth0: [
                { address: 'fe80::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
                { address: '192.168.1.10', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
            ],
        });
        expect(interfaceAddress('eth0')).toBe('192.168.1.10');
    });

    it('is empty — never a guess — for an unknown name, no name, or IPv6-only', () => {
        mockNics.mockReturnValue({
            lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
            tun0: [{ address: 'fe80::2', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo],
        });
        expect(interfaceAddress('')).toBe('');
        expect(interfaceAddress('eth9')).toBe('');
        expect(interfaceAddress('tun0')).toBe('');
        expect(interfaceAddress('lo')).toBe(''); // internal: a join here reaches nothing
    });
});

describe('registerNetworkInterfaceDeviceProvider', () => {
    function fakeServices() {
        const providers = new Map<string, unknown>();
        return {
            deviceProviders: {
                getProvider: (t: string) => providers.get(t),
                register: vi.fn((p: { type: string }) => providers.set(p.type, p)),
            },
        } as never;
    }

    it('registers the network-interface provider', () => {
        const services = fakeServices() as any;
        registerNetworkInterfaceDeviceProvider(services);
        expect(services.deviceProviders.register).toHaveBeenCalledWith(
            expect.objectContaining({ type: NETWORK_INTERFACE_DEVICE_TYPE }),
        );
    });

    it('is idempotent — a second call does not re-register', () => {
        const services = fakeServices() as any;
        registerNetworkInterfaceDeviceProvider(services);
        registerNetworkInterfaceDeviceProvider(services);
        expect(services.deviceProviders.register).toHaveBeenCalledTimes(1);
    });
});

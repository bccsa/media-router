import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    buildUdpSink,
    buildUdpSrc,
    buildNetUdpSrc,
    buildNetUdpSink,
    busSocketPath,
    busTransport,
    isMulticast,
    isMulticastAddr,
} from './udpHelpers.js';

describe('isMulticast', () => {
    it('flags 239.x addresses as multicast', () => {
        expect(isMulticast('239.255.0.1')).toBe(true);
    });
    it('does not flag unicast addresses', () => {
        expect(isMulticast('127.0.0.1')).toBe(false);
        expect(isMulticast('10.9.1.166')).toBe(false);
    });
});

describe('isMulticastAddr', () => {
    it('covers the full 224.-239. class-D range', () => {
        expect(isMulticastAddr('224.0.0.1')).toBe(true);
        expect(isMulticastAddr('232.1.2.3')).toBe(true);
        expect(isMulticastAddr('239.255.0.1')).toBe(true);
    });
    it('rejects unicast and out-of-range addresses', () => {
        expect(isMulticastAddr('10.9.16.20')).toBe(false);
        expect(isMulticastAddr('223.0.0.1')).toBe(false);
        expect(isMulticastAddr('240.0.0.1')).toBe(false);
        expect(isMulticastAddr('0.0.0.0')).toBe(false);
    });
});

describe('buildNetUdpSrc', () => {
    it('listens on a bare port for unicast (no multicast group)', () => {
        expect(buildNetUdpSrc({ port: 5000 })).toBe(
            'udpsrc port=5000 buffer-size=4194304',
        );
    });
    it('joins a multicast group with iface and auto-multicast', () => {
        const s = buildNetUdpSrc({ port: 5004, multicastGroup: '239.1.1.1', iface: 'eth0' });
        expect(s).toContain('multicast-group=239.1.1.1 port=5004');
        expect(s).toContain('multicast-iface=eth0');
        expect(s).toContain('auto-multicast=true');
    });
    it('omits multicast-iface when no interface is given', () => {
        const s = buildNetUdpSrc({ port: 5004, multicastGroup: '239.1.1.1' });
        expect(s).not.toContain('multicast-iface');
    });
    it('treats a unicast multicastGroup as plain unicast', () => {
        const s = buildNetUdpSrc({ port: 5004, multicastGroup: '10.0.0.1' });
        expect(s).not.toContain('multicast-group');
    });
    it('appends name, caps, and timeout when provided', () => {
        const s = buildNetUdpSrc({ name: 'netsrc', port: 1, caps: 'video/mpegts', timeoutNs: 5_000_000_000 });
        expect(s).toContain('udpsrc name=netsrc');
        expect(s).toContain('timeout=5000000000');
        expect(s).toContain('caps="video/mpegts"');
    });
});

describe('buildNetUdpSink', () => {
    it('uses ttl-mc + iface for multicast hosts', () => {
        const s = buildNetUdpSink({ name: 'netsink', host: '239.1.1.1', port: 5000, iface: 'eth0', ttl: 8 });
        expect(s).toContain('udpsink name=netsink host=239.1.1.1 port=5000');
        expect(s).toContain('multicast-iface=eth0');
        expect(s).toContain('auto-multicast=true');
        expect(s).toContain('ttl-mc=8');
        expect(s).toContain('sync=false');
    });
    it('uses plain ttl (not ttl-mc) and no iface for unicast hosts', () => {
        const s = buildNetUdpSink({ host: '10.9.16.20', port: 5000, ttl: 32 });
        expect(s).toContain('host=10.9.16.20 port=5000 ttl=32');
        expect(s).not.toContain('ttl-mc');
        expect(s).not.toContain('multicast-iface');
    });
    it('omits ttl clauses when ttl is undefined', () => {
        expect(buildNetUdpSink({ host: '10.0.0.1', port: 5000 })).not.toContain('ttl');
    });
});

describe('buildUdpSrc', () => {
    it('uses multicast-group + multicast-iface for 239.x hosts', () => {
        const s = buildUdpSrc({ host: '239.255.0.1', port: 5500 });
        expect(s).toBe(
            'udpsrc multicast-group=239.255.0.1 port=5500 multicast-iface=lo auto-multicast=true buffer-size=4194304',
        );
    });
    it('uses bare port for unicast hosts', () => {
        const s = buildUdpSrc({ host: '127.0.0.1', port: 5500 });
        expect(s).toBe('udpsrc port=5500 buffer-size=4194304');
    });
    it('respects an explicit bufferSize', () => {
        const s = buildUdpSrc({ host: '127.0.0.1', port: 1, bufferSize: 65_536 });
        expect(s).toContain('buffer-size=65536');
    });
    it('appends caps when provided and quotes the value', () => {
        const s = buildUdpSrc({
            host: '239.255.0.1',
            port: 1,
            caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
        });
        expect(s).toContain(
            'caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188"',
        );
    });
    it('emits the optional element name', () => {
        expect(buildUdpSrc({ name: 'src0', host: '127.0.0.1', port: 1 })).toContain(
            'udpsrc name=src0',
        );
    });
    it('omits timeout when not set', () => {
        const s = buildUdpSrc({ host: '127.0.0.1', port: 1 });
        expect(s).not.toContain('timeout=');
    });
    it('emits timeout=NS for unicast sources when timeoutNs is set', () => {
        const s = buildUdpSrc({ host: '127.0.0.1', port: 1, timeoutNs: 5_000_000_000 });
        expect(s).toContain('timeout=5000000000');
    });
    it('emits timeout=NS for multicast sources when timeoutNs is set', () => {
        const s = buildUdpSrc({ host: '239.255.0.1', port: 1, timeoutNs: 5_000_000_000 });
        expect(s).toContain('timeout=5000000000');
        expect(s).toContain('multicast-group=239.255.0.1');
    });
});

describe('buildUdpSink', () => {
    it('uses multicast-iface + auto-multicast for 239.x hosts', () => {
        const s = buildUdpSink({ name: 'usink', host: '239.255.0.1', port: 5500 });
        expect(s).toBe(
            'udpsink name=usink host=239.255.0.1 port=5500 multicast-iface=lo auto-multicast=true buffer-size=4194304 sync=false',
        );
    });
    it('drops multicast-iface for unicast hosts', () => {
        const s = buildUdpSink({ host: '127.0.0.1', port: 5500 });
        expect(s).toBe('udpsink host=127.0.0.1 port=5500 buffer-size=4194304 sync=false');
    });
    it('honours sync=true when requested', () => {
        const s = buildUdpSink({ host: '127.0.0.1', port: 1, sync: true });
        expect(s).toContain('sync=true');
    });
    it('omits async clause by default (keeps GStreamer default async=true)', () => {
        expect(buildUdpSink({ host: '127.0.0.1', port: 1 })).not.toContain('async');
        expect(buildUdpSink({ host: '239.255.0.1', port: 1 })).not.toContain('async');
    });
    it('emits async=false when requested (runtime-added sinks must not preroll)', () => {
        expect(buildUdpSink({ host: '127.0.0.1', port: 1, async: false })).toContain('async=false');
        expect(buildUdpSink({ host: '239.255.0.1', port: 1, async: false })).toContain('async=false');
    });
});

describe('unixfd bus transport (MR_BUS_TRANSPORT=unixfd)', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('defaults to udp when the env var is unset or unrecognised', () => {
        expect(busTransport()).toBe('udp');
        vi.stubEnv('MR_BUS_TRANSPORT', 'bogus');
        expect(busTransport()).toBe('udp');
    });

    it('derives the socket path from the port, honouring MR_BUS_SOCKET_DIR', () => {
        expect(busSocketPath(40001)).toBe('/tmp/mr-bus-40001.sock');
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busSocketPath(40001)).toBe('/run/mr/mr-bus-40001.sock');
    });

    it('swaps the multicast bus source for unixfdsrc, dropping udp-only options', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        const s = buildUdpSrc({
            name: 'busin',
            host: '239.255.0.1',
            port: 40001,
            caps: 'video/mpegts',
            timeoutNs: 5_000_000_000,
            bufferSize: 65_536,
        });
        // The trailing leaky queue is the consumer drain contract — see
        // buildUdpSrc: a consumer that stops reading must shed its own
        // buffers, not freeze the producer's blocking unixfdsink sends.
        expect(s).toBe(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('swaps the multicast bus sink for unixfdsink, keeping sync/async mapping', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        // TS capsfilter pinned at egress: raw-byte producers (srtsrc) never
        // emit caps and unixfd consumers fail not-negotiated without them.
        expect(buildUdpSink({ name: 'usink', host: '239.255.0.1', port: 40001 })).toBe(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! unixfdsink name=usink socket-path=/tmp/mr-bus-40001.sock sync=false',
        );
        expect(buildUdpSink({ host: '239.255.0.1', port: 1, async: false })).toContain(
            'async=false',
        );
        expect(buildUdpSink({ host: '239.255.0.1', port: 1, sync: true })).toContain('sync=true');
    });

    it('leaves unicast loopback and network-facing builders on udp', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        expect(buildUdpSrc({ host: '127.0.0.1', port: 5500 })).toContain('udpsrc');
        expect(buildUdpSink({ host: '10.9.16.20', port: 5500 })).toContain('udpsink');
        expect(buildNetUdpSrc({ port: 5004, multicastGroup: '239.1.1.1' })).toContain('udpsrc');
        expect(buildNetUdpSink({ host: '239.1.1.1', port: 5000 })).toContain('udpsink');
    });
});

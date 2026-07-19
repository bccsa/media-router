import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    buildUdpSink,
    buildUdpSrc,
    buildNetUdpSrc,
    buildNetUdpSink,
    busSocketPath,
    busTeeName,
    busEdgeSocketPath,
    busIngestSocketPath,
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
        // LEAKY deep ingress (5 s, above any steady-state skew): consumers
        // must never stop draining their socket — stock unixfdsink blocks in
        // send under its object lock, so a back-pressuring consumer freezes
        // its upstream producer and the stall cascades through the graph.
        expect(s).toBe(
            'unixfdsrc name=busin socket-path=/tmp/mr-bus-40001.sock' +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
    });

    it('makes the multicast bus sink a per-consumer fan-out tee', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        // The egress is a tee (named by port) with allow-not-linked so the
        // producer runs with zero consumers; the actual unixfdsink branches
        // are attached per consumer at runtime (bus_attach). TS capsfilter is
        // pinned before the tee (unixfd consumers fail not-negotiated without
        // caps) and inherited by every branch.
        expect(buildUdpSink({ name: 'usink', host: '239.255.0.1', port: 40001 })).toBe(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                'tee name=busout_40001 allow-not-linked=true',
        );
    });

    it('derives the non-gst producer ingest socket from the port, honouring MR_BUS_SOCKET_DIR', () => {
        expect(busIngestSocketPath(40001)).toBe('/tmp/mr-bus-40001-ingest.sock');
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busIngestSocketPath(40001)).toBe('/run/mr/mr-bus-40001-ingest.sock');
    });

    it('derives deterministic tee + per-edge socket names from the port', () => {
        expect(busTeeName(40001)).toBe('busout_40001');
        // Per-edge socket: stable per (port, connId), short enough for AF_UNIX.
        const a = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-mpegts-muxer-y:audio-0');
        const b = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-mpegts-muxer-y:audio-0');
        const c = busEdgeSocketPath(40001, 'srt-input-x:mpegts-out-audio-decoder-z:mpegts-in');
        expect(a).toBe(b); // deterministic
        expect(a).not.toBe(c); // distinct consumers → distinct sockets
        expect(a.startsWith('/tmp/mr-bus-40001-')).toBe(true);
        expect(a.endsWith('.sock')).toBe(true);
        expect(a.length).toBeLessThan(108); // AF_UNIX path cap
        vi.stubEnv('MR_BUS_SOCKET_DIR', '/run/mr');
        expect(busEdgeSocketPath(40001, a).startsWith('/run/mr/')).toBe(true);
    });

    it('unixfdsrc connects to the per-consumer edge socket when supplied', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        const edge = '/tmp/mr-bus-40001-ab12cd.sock';
        expect(buildUdpSrc({ host: '239.255.0.1', port: 40001, socketPath: edge })).toBe(
            `unixfdsrc socket-path=${edge}` +
                ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0',
        );
        // Falls back to the channel socket when no edge socket is given.
        expect(buildUdpSrc({ host: '239.255.0.1', port: 40001 })).toContain(
            'socket-path=/tmp/mr-bus-40001.sock',
        );
    });

    it('leaves unicast loopback and network-facing builders on udp', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        expect(buildUdpSrc({ host: '127.0.0.1', port: 5500 })).toContain('udpsrc');
        expect(buildUdpSink({ host: '10.9.16.20', port: 5500 })).toContain('udpsink');
        expect(buildNetUdpSrc({ port: 5004, multicastGroup: '239.1.1.1' })).toContain('udpsrc');
        expect(buildNetUdpSink({ host: '239.1.1.1', port: 5000 })).toContain('udpsink');
    });
});

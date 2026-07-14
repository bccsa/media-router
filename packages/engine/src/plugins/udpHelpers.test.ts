import { describe, it, expect } from 'vitest';
import {
    buildUdpSink,
    buildUdpSrc,
    buildNetUdpSrc,
    buildNetUdpSink,
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

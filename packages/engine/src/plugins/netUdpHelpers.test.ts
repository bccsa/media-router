import { describe, it, expect } from 'vitest';
import { buildNetUdpSrc, buildNetUdpSink, isMulticastAddr } from './netUdpHelpers.js';

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

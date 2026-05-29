import { describe, it, expect } from 'vitest';
import { buildUdpSink, buildUdpSrc, isMulticast } from './udpHelpers.js';

describe('isMulticast', () => {
    it('flags 239.x addresses as multicast', () => {
        expect(isMulticast('239.255.0.1')).toBe(true);
    });
    it('does not flag unicast addresses', () => {
        expect(isMulticast('127.0.0.1')).toBe(false);
        expect(isMulticast('10.9.1.166')).toBe(false);
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
});

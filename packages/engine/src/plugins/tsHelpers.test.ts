import { describe, it, expect } from 'vitest';
import { buildLeakyQueue, buildTsUdpInput, videoParserForCodec } from './tsHelpers.js';

describe('buildLeakyQueue', () => {
    it('emits a leaky=2 queue with byte/buffer caps disabled', () => {
        expect(buildLeakyQueue(50)).toBe(
            'queue leaky=2 max-size-time=50000000 max-size-buffers=0 max-size-bytes=0',
        );
    });
    it('clamps negative values to 0', () => {
        expect(buildLeakyQueue(-10)).toContain('max-size-time=0');
    });
    it('clamps absurdly large values to 2 seconds', () => {
        expect(buildLeakyQueue(99_999)).toContain('max-size-time=2000000000');
    });
});

describe('videoParserForCodec', () => {
    it('returns h264parse for h264 and undefined (legacy)', () => {
        expect(videoParserForCodec('h264')).toContain('h264parse');
        expect(videoParserForCodec(undefined)).toContain('h264parse');
    });
    it('returns null for unknown codec', () => {
        expect(videoParserForCodec('vp9')).toBeNull();
    });
});

describe('buildTsUdpInput', () => {
    it('chains udpsrc → leaky queue → tsparse with TS caps on udpsrc', () => {
        const s = buildTsUdpInput({ host: '239.255.0.1', port: 5500 });
        // udpsrc declares MPEG-TS caps so caps negotiation works before data flows
        expect(s).toContain('udpsrc');
        expect(s).toContain('multicast-group=239.255.0.1');
        expect(s).toContain('caps="video/mpegts');
        // jitter queue defaults to 50 ms
        expect(s).toContain('queue leaky=2 max-size-time=50000000');
        // tsparse re-anchors PCR to local clock (the load-bearing fix)
        expect(s).toContain('tsparse set-timestamps=true');
        // ordering: udpsrc, then queue, then tsparse
        const idxUdp = s.indexOf('udpsrc');
        const idxQueue = s.indexOf('queue');
        const idxTsparse = s.indexOf('tsparse');
        expect(idxUdp).toBeLessThan(idxQueue);
        expect(idxQueue).toBeLessThan(idxTsparse);
    });
    it('honours a custom jitterMs', () => {
        const s = buildTsUdpInput({ host: '127.0.0.1', port: 1, jitterMs: 100 });
        expect(s).toContain('max-size-time=100000000');
    });
    it('forwards timeoutNs to udpsrc', () => {
        const s = buildTsUdpInput({ host: '127.0.0.1', port: 1, timeoutNs: 5_000_000_000 });
        expect(s).toContain('timeout=5000000000');
    });
    it('emits the optional udpsrc name', () => {
        const s = buildTsUdpInput({ host: '127.0.0.1', port: 1, udpsrcName: 'in0' });
        expect(s).toContain('udpsrc name=in0');
    });
});

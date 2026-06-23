import { describe, it, expect } from 'vitest';
import {
    audioStreamPid,
    buildLeakyQueue,
    buildBackpressureQueue,
    buildTsUdpInput,
    muxSinkPadName,
    TS_AUDIO_PID_BASE,
    TS_VIDEO_PID_BASE,
    videoStreamPid,
} from './tsHelpers.js';

describe('deterministic PID scheme (D3)', () => {
    it('places video PIDs at 0x100 + index', () => {
        expect(TS_VIDEO_PID_BASE).toBe(0x100);
        expect(videoStreamPid(0)).toBe(0x100);
        expect(videoStreamPid(3)).toBe(0x103);
    });
    it('places audio PIDs at 0x140 + index', () => {
        expect(TS_AUDIO_PID_BASE).toBe(0x140);
        expect(audioStreamPid(0)).toBe(0x140);
        expect(audioStreamPid(1)).toBe(0x141);
    });
    it('keeps video and audio ranges from colliding for realistic counts', () => {
        // 0x100..0x13f is 64 video slots before the audio base — far more than
        // any real stream count, so the two media types never overlap.
        expect(videoStreamPid(63)).toBeLessThan(audioStreamPid(0));
    });
    it('formats the mpegtsmux request-pad name as sink_<pid>', () => {
        expect(muxSinkPadName(0x100)).toBe('sink_256');
        expect(muxSinkPadName(audioStreamPid(1))).toBe('sink_321');
    });
});

describe('buildLeakyQueue', () => {
    it('emits a leaky=2 queue with byte/buffer caps disabled', () => {
        expect(buildLeakyQueue(50)).toBe(
            'queue leaky=2 max-size-time=50000000 max-size-buffers=0 max-size-bytes=0',
        );
    });
    it('clamps negative values to 0', () => {
        expect(buildLeakyQueue(-10)).toContain('max-size-time=0');
    });
    it('clamps absurdly large values to 5 seconds', () => {
        expect(buildLeakyQueue(99_999)).toContain('max-size-time=5000000000');
    });
});

describe('buildBackpressureQueue', () => {
    it('emits a NON-leaky (leaky=0) bounded queue — back-pressures instead of dropping', () => {
        expect(buildBackpressureQueue(200)).toBe(
            'queue leaky=0 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0',
        );
    });
    it('clamps negative values to 0 and huge values to 5 s, like buildLeakyQueue', () => {
        expect(buildBackpressureQueue(-10)).toContain('max-size-time=0');
        expect(buildBackpressureQueue(99_999)).toContain('max-size-time=5000000000');
    });
});

describe('buildTsUdpInput', () => {
    it('chains udpsrc → leaky queue → tsparse with TS caps on udpsrc', () => {
        const s = buildTsUdpInput({ host: '239.255.0.1', port: 5500 });
        // udpsrc declares MPEG-TS caps so caps negotiation works before data flows
        expect(s).toContain('udpsrc');
        expect(s).toContain('multicast-group=239.255.0.1');
        expect(s).toContain('caps="video/mpegts');
        // jitter queue defaults to 200 ms (absorbs encoder I-frame bursts)
        expect(s).toContain('queue leaky=2 max-size-time=200000000');
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

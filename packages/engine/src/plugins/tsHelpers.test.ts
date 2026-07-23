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
    it('floors 0/negative to 20 ms — all-zero bounds would mean UNLIMITED, never-leaking', () => {
        expect(buildLeakyQueue(0)).toContain('max-size-time=20000000');
        expect(buildLeakyQueue(-10)).toContain('max-size-time=20000000');
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
    it('floors 0/negative to 20 ms and clamps huge values to 5 s, like buildLeakyQueue', () => {
        expect(buildBackpressureQueue(-10)).toContain('max-size-time=20000000');
        expect(buildBackpressureQueue(0)).toContain('max-size-time=20000000');
        expect(buildBackpressureQueue(99_999)).toContain('max-size-time=5000000000');
    });
});

describe('buildTsUdpInput', () => {
    it('chains unixfdsrc bus ingress → jitter queue → tsparse', () => {
        const s = buildTsUdpInput({ port: 5500 });
        // Bus ingress connects the channel socket (caps arrive over the socket)
        expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-5500.sock');
        // buildBusSrc's leaky deep ingress queue (5 s)
        expect(s).toContain('queue leaky=2 max-size-time=5000000000');
        // jitter queue defaults to 200 ms (absorbs encoder I-frame bursts)
        expect(s).toContain('queue leaky=2 max-size-time=200000000');
        // tsparse re-anchors PCR to local clock (the load-bearing fix)
        expect(s).toContain('tsparse set-timestamps=true');
        // ordering: unixfdsrc, then jitter queue, then tsparse
        const idxSrc = s.indexOf('unixfdsrc');
        const idxJitter = s.indexOf('max-size-time=200000000');
        const idxTsparse = s.indexOf('tsparse');
        expect(idxSrc).toBeLessThan(idxJitter);
        expect(idxJitter).toBeLessThan(idxTsparse);
    });
    it('honours a custom jitterMs', () => {
        const s = buildTsUdpInput({ port: 1, jitterMs: 100 });
        expect(s).toContain('max-size-time=100000000');
    });
    it('connects to the per-consumer edge socket when supplied', () => {
        const s = buildTsUdpInput({ port: 1, socketPath: '/tmp/mr-bus-1-ab12cd.sock' });
        expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-1-ab12cd.sock');
    });
    it('inserts the bus stall watchdog when stallTimeoutMs is set', () => {
        const s = buildTsUdpInput({ port: 1, udpsrcName: 'in0', stallTimeoutMs: 5000 });
        expect(s).toContain(' ! watchdog name=buswd_in0 timeout=5000 ! ');
    });
    it('emits the optional element name on the unixfdsrc', () => {
        const s = buildTsUdpInput({ port: 1, udpsrcName: 'in0' });
        expect(s).toContain('unixfdsrc name=in0');
    });
    it('can preserve source PTS with setTimestamps=false (cross-pipeline A/V sync)', () => {
        expect(buildTsUdpInput({ port: 1, setTimestamps: false })).toContain(
            'tsparse set-timestamps=false',
        );
    });
});

import { describe, it, expect } from 'vitest';
import {
    audioStreamPid,
    buildIngestQueue,
    buildBackpressureQueue,
    INGEST_QUEUE_MS,
    INGEST_QUEUE_NAME,
    muxSinkPadName,
    TS_AUDIO_PID_BASE,
    TS_VIDEO_PID_BASE,
    videoStreamPid,
} from './tsHelpers.js';
import { tsQueueByteCap } from './queueBounds.js';

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

describe('buildBackpressureQueue × byte cap', () => {
    it('applies the cap when passed, and keeps it off (raw-video safe) by default', () => {
        // gate01 2026-09-06: a time-only queue is unbounded once the stamps flowing through it
        // stall: the byte bound is what still holds.
        expect(buildBackpressureQueue(500, tsQueueByteCap(500))).toBe(
            'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=4000000',
        );
        expect(buildBackpressureQueue(500)).toContain('max-size-bytes=0');
    });
});

describe('buildBackpressureQueue', () => {
    it('emits a NON-leaky (leaky=0) bounded queue — back-pressures instead of dropping', () => {
        expect(buildBackpressureQueue(200)).toBe(
            'queue leaky=0 max-size-time=200000000 max-size-buffers=0 max-size-bytes=0',
        );
    });
    it('floors 0/negative to 20 ms (all-zero bounds are UNLIMITED) and clamps huge values to 5 s', () => {
        expect(buildBackpressureQueue(-10)).toContain('max-size-time=20000000');
        expect(buildBackpressureQueue(0)).toContain('max-size-time=20000000');
        expect(buildBackpressureQueue(99_999)).toContain('max-size-time=5000000000');
    });
});

describe('buildIngestQueue (B-182)', () => {
    it('is leaky, named for the runner, and bounded by bytes alone: 500 ms at 64 Mbit/s', () => {
        expect(INGEST_QUEUE_NAME).toBe('ingestq');
        expect(buildIngestQueue()).toBe(
            'queue name=ingestq leaky=2 max-size-time=0 max-size-buffers=0 max-size-bytes=4000000 ' +
                'flush-on-eos=true',
        );
        expect(tsQueueByteCap(INGEST_QUEUE_MS)).toBe(4_000_000);
        // 800 ms at 40 Mbit/s: a 500 ms stall of the bus egress is held whole.
        expect((4_000_000 * 8) / 40e6).toBeGreaterThanOrEqual(0.8);
    });
});

import { describe, it, expect } from 'vitest';
import {
    OUTPUT_CATCH_UP_PPM,
    OUTPUT_MARGIN_MS,
    OUTPUT_QUEUE_NAME,
    OUTPUT_RING_US,
    buildOutputQueue,
} from './outputSink.js';
import { buildAsrc } from './ingestTiming.js';

describe("the audio outputs' sink end (OQ-31, B-249)", () => {
    it('pins the 100 ms ring and the 60 ms margin', () => {
        expect(OUTPUT_RING_US).toBe(100_000);
        expect(OUTPUT_MARGIN_MS).toBe(60);
    });

    it('the queue never leaks, holds no threshold, and is bounded by time alone', () => {
        expect(buildOutputQueue()).toBe(
            `queue name=${OUTPUT_QUEUE_NAME} leaky=0 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0`,
        );
        expect(buildOutputQueue()).not.toContain('min-threshold');
        expect(OUTPUT_QUEUE_NAME).toBe('outq');
    });

    it("every output's ASRC keeps the margin in its sink; no other mode has one", () => {
        expect(buildAsrc({ name: 'a', deviceSink: 'sink' })).toBe(
            'mrasrc name=a device-sink=sink margin-ms=60 catch-up-ppm=5000',
        );
        expect(buildAsrc({ name: 'a', bypassBelowPpm: 0.5 })).not.toContain('margin-ms');
        expect(buildAsrc({ name: 'a' })).not.toContain('margin-ms');
    });

    it('every output plays what it holds past the margin back down at 0.5 %, counting a named queue before it', () => {
        expect(OUTPUT_CATCH_UP_PPM).toBe(5000);
        expect(buildAsrc({ name: 'a', deviceSink: 'sink', upstreamQueue: 'decq' })).toBe(
            'mrasrc name=a device-sink=sink margin-ms=60 catch-up-ppm=5000 upstream-queue=decq',
        );
        expect(buildAsrc({ name: 'a', upstreamQueue: 'decq' })).toBe('mrasrc name=a');
        expect(buildAsrc({ name: 'a', bypassBelowPpm: 0.5 })).not.toContain('catch-up');
    });
});

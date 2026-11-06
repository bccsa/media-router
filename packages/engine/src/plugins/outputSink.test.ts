import { describe, it, expect } from 'vitest';
import {
    OUTPUT_PREFILL_MS,
    OUTPUT_PREFILL_NAME,
    OUTPUT_RING_US,
    buildOutputPrefill,
} from './outputSink.js';

describe("the audio outputs' sink end (OQ-31)", () => {
    it('pins the 100 ms ring and the 40 ms prefill', () => {
        expect(OUTPUT_RING_US).toBe(100_000);
        expect(OUTPUT_PREFILL_MS).toBe(40);
    });

    it('the prefill holds 40 ms, never leaks, and is bounded by time alone', () => {
        expect(buildOutputPrefill()).toBe(
            `queue name=${OUTPUT_PREFILL_NAME} leaky=0 min-threshold-time=40000000` +
                ' max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0',
        );
        expect(OUTPUT_PREFILL_NAME).toBe('prefill');
    });
});

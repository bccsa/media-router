import { describe, it, expect } from 'vitest';
import { tsQueueByteCap, TS_QUEUE_BYTES_PER_MS } from './queueBounds.js';

describe('tsQueueByteCap — timestamp-independent byte backstop for compressed queues', () => {
    it('sizes the cap as 64 Mbit/s worth of the time bound', () => {
        expect(TS_QUEUE_BYTES_PER_MS).toBe(8_000);
        expect(tsQueueByteCap(500)).toBe(4_000_000);
        expect(tsQueueByteCap(5000)).toBe(40_000_000);
    });
    it('floors tiny bounds at 1 MiB so a single large access unit never trips it', () => {
        expect(tsQueueByteCap(20)).toBe(1_048_576);
        expect(tsQueueByteCap(100)).toBe(1_048_576);
    });
});

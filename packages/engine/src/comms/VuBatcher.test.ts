import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VuBatcher } from './VuBatcher.js';

describe('VuBatcher', () => {
    let sendBatch: ReturnType<typeof vi.fn>;
    let batcher: VuBatcher;

    beforeEach(() => {
        vi.useFakeTimers();
        sendBatch = vi.fn();
        batcher = new VuBatcher(sendBatch);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces all modules inside one flush window into a single batch', () => {
        batcher.enqueue('mod-1', [-12.5, -13.1]);
        batcher.enqueue('mod-2', [-6.0]);
        expect(sendBatch).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledTimes(1);
        expect(sendBatch).toHaveBeenCalledWith({
            'mod-1': [-12.5, -13.1],
            'mod-2': [-6.0],
        });
    });

    it('keeps only the latest reading per module within a window', () => {
        batcher.enqueue('mod-1', [-20]);
        batcher.enqueue('mod-1', [-10]);

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': [-10] });
    });

    it('skips unchanged readings inside the heartbeat window', () => {
        expect(batcher.enqueue('mod-1', [-10])).toBe(true);
        vi.advanceTimersByTime(250);
        sendBatch.mockClear();

        // Identical reading, heartbeat not elapsed — nothing queued, no flush.
        expect(batcher.enqueue('mod-1', [-10])).toBe(false);
        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();
    });

    it('re-sends an unchanged reading once the heartbeat elapses (meters never freeze stale)', () => {
        batcher.enqueue('mod-1', [-10]);
        vi.advanceTimersByTime(250);
        sendBatch.mockClear();

        vi.advanceTimersByTime(1000); // past heartbeatMs
        expect(batcher.enqueue('mod-1', [-10])).toBe(true);
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': [-10] });
    });

    it('always queues a changed reading', () => {
        batcher.enqueue('mod-1', [-10]);
        vi.advanceTimersByTime(250);
        sendBatch.mockClear();

        expect(batcher.enqueue('mod-1', [-9.9])).toBe(true);
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': [-9.9] });
    });

    it('drop removes a deleted module from the pending batch and dedup cache', () => {
        batcher.enqueue('mod-1', [-10]);
        batcher.enqueue('mod-2', [-20]);
        batcher.drop('mod-1');

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-2': [-20] });

        // Dedup cache gone too — a re-added module with the same reading sends.
        expect(batcher.enqueue('mod-1', [-10])).toBe(true);
    });

    it('reset clears the batch and dedup so a reconnect starts clean', () => {
        batcher.enqueue('mod-1', [-10]);
        batcher.reset();

        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();

        // Same reading post-reset must not be dedup-suppressed.
        expect(batcher.enqueue('mod-1', [-10])).toBe(true);
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': [-10] });
    });
});

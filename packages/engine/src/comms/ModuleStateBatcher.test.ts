import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { ModuleStateBatcher } from './ModuleStateBatcher.js';

const state = (over: Record<string, unknown> = {}): ModuleRuntimeState =>
    ({ running: true, health: 'ok', ...over }) as unknown as ModuleRuntimeState;

describe('ModuleStateBatcher', () => {
    let sendBatch: ReturnType<typeof vi.fn>;
    let batcher: ModuleStateBatcher;

    beforeEach(() => {
        vi.useFakeTimers();
        sendBatch = vi.fn();
        batcher = new ModuleStateBatcher(sendBatch);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces enqueues inside the flush window into one send', () => {
        batcher.enqueue('mod-1', state());
        batcher.enqueue('mod-2', state({ running: false, health: 'stopped' }));
        expect(sendBatch).not.toHaveBeenCalled();

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledTimes(1);
        expect(sendBatch).toHaveBeenCalledWith({
            'mod-1': { running: true, health: 'ok' },
            'mod-2': { running: false, health: 'stopped' },
        });
    });

    it('keeps only the latest state per module within a window', () => {
        batcher.enqueue('mod-1', state({ running: false, health: 'stopped' }));
        batcher.enqueue('mod-1', state());

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledTimes(1);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': { running: true, health: 'ok' } });
    });

    it('dedups byte-identical re-enqueues (stats tick with no change)', () => {
        batcher.enqueue('mod-1', state());
        vi.advanceTimersByTime(250);
        sendBatch.mockClear();

        batcher.enqueue('mod-1', state());
        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();
    });

    it('strips vuData from the batch', () => {
        batcher.enqueue('mod-1', state({ vuData: [-12.5, -13.1] }));
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': { running: true, health: 'ok' } });
    });

    it('vuData-only churn does not re-send', () => {
        batcher.enqueue('mod-1', state({ vuData: [-10] }));
        vi.advanceTimersByTime(250);
        sendBatch.mockClear();

        batcher.enqueue('mod-1', state({ vuData: [-42] }));
        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();
    });

    it('drop removes the module from the pending batch and the dedup cache', () => {
        batcher.enqueue('mod-1', state());
        batcher.enqueue('mod-2', state());
        batcher.drop('mod-1');

        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-2': { running: true, health: 'ok' } });
        sendBatch.mockClear();

        // A re-created module with the same id and state must send again.
        batcher.enqueue('mod-1', state());
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': { running: true, health: 'ok' } });
    });

    it('snapshot returns lean states, refreshes the dedup cache, and cancels the pending flush', () => {
        batcher.enqueue('mod-1', state());

        const lean = batcher.snapshot({ 'mod-1': state({ vuData: [-3] }) });
        expect(lean).toEqual({ 'mod-1': { running: true, health: 'ok' } });

        // Pending batch was absorbed by the snapshot — nothing extra flushes…
        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();

        // …and the snapshot primed the dedup for the incremental path.
        batcher.enqueue('mod-1', state());
        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();
    });

    it('snapshot returns null when there are no modules', () => {
        expect(batcher.snapshot({})).toBeNull();
    });

    it('reset clears the pending batch and dedup cache', () => {
        batcher.enqueue('mod-1', state());
        batcher.reset();

        vi.advanceTimersByTime(250);
        expect(sendBatch).not.toHaveBeenCalled();

        // Same state again post-reset must not be dedup-suppressed.
        batcher.enqueue('mod-1', state());
        vi.advanceTimersByTime(250);
        expect(sendBatch).toHaveBeenCalledWith({ 'mod-1': { running: true, health: 'ok' } });
    });
});

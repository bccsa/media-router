/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useVuStore } from './vuMeters';

describe('useVuStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('starts empty', () => {
        const store = useVuStore();
        expect(store.get('eng-1', 'mod-1')).toBeUndefined();
    });

    it('stores and retrieves VU data', () => {
        const store = useVuStore();
        store.update('eng-1', 'audio-input-abc', [5, 5]);
        expect(store.get('eng-1', 'audio-input-abc')).toEqual([5, 5]);
    });

    it('updates existing VU data', () => {
        const store = useVuStore();
        store.update('eng-1', 'mod-1', [3, 3]);
        store.update('eng-1', 'mod-1', [7, 7]);
        expect(store.get('eng-1', 'mod-1')).toEqual([7, 7]);
    });

    it('handles mono VU data', () => {
        const store = useVuStore();
        store.update('eng-1', 'mod-1', [10]);
        expect(store.get('eng-1', 'mod-1')).toEqual([10]);
    });

    it('tracks multiple modules independently', () => {
        const store = useVuStore();
        store.update('eng-1', 'mod-a', [5]);
        store.update('eng-1', 'mod-b', [10]);
        expect(store.get('eng-1', 'mod-a')).toEqual([5]);
        expect(store.get('eng-1', 'mod-b')).toEqual([10]);
    });

    it('tracks multiple engines independently', () => {
        const store = useVuStore();
        store.update('eng-1', 'mod-1', [3]);
        store.update('eng-2', 'mod-1', [8]);
        expect(store.get('eng-1', 'mod-1')).toEqual([3]);
        expect(store.get('eng-2', 'mod-1')).toEqual([8]);
    });

    it('clears all VU data for an engine', () => {
        const store = useVuStore();
        store.update('eng-1', 'mod-a', [5]);
        store.update('eng-1', 'mod-b', [10]);
        store.update('eng-2', 'mod-c', [7]);

        store.clear('eng-1');

        expect(store.get('eng-1', 'mod-a')).toBeUndefined();
        expect(store.get('eng-1', 'mod-b')).toBeUndefined();
        expect(store.get('eng-2', 'mod-c')).toEqual([7]); // other engine unaffected
    });

    it('clear on empty store is safe', () => {
        const store = useVuStore();
        expect(() => store.clear('eng-1')).not.toThrow();
    });

    it('holds the last value until the 2s stale threshold elapses', async () => {
        vi.useFakeTimers();
        const store = useVuStore();
        store.update('eng-1', 'mod-1', [8, 8]);

        // Just before the 2s threshold — should still hold the last value
        vi.advanceTimersByTime(1900);
        expect(store.get('eng-1', 'mod-1')).toEqual([8, 8]);

        // Past 2s threshold + one cleanup tick (500ms) — should be zeroed
        vi.advanceTimersByTime(700);
        expect(store.get('eng-1', 'mod-1')).toEqual([0, 0]);
        vi.useRealTimers();
    });

    it('does not reset VU data that is still being updated', async () => {
        vi.useFakeTimers();
        const store = useVuStore();
        store.update('eng-1', 'mod-1', [5, 5]);

        // Update again before staleness
        vi.advanceTimersByTime(400);
        store.update('eng-1', 'mod-1', [6, 6]);

        // Advance another 400ms (total 800 from first, 400 from last update)
        vi.advanceTimersByTime(400);
        expect(store.get('eng-1', 'mod-1')).toEqual([6, 6]); // still fresh

        vi.useRealTimers();
    });
});

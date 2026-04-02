import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useVuStore } from './vuMeters';

describe('VU Meters Store', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setActivePinia(createPinia());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stores and retrieves VU data', () => {
        const store = useVuStore();
        store.update('mic-1', [-12, -15]);
        expect(store.get('mic-1')).toEqual([-12, -15]);
    });

    it('returns empty array for unknown instanceId', () => {
        const store = useVuStore();
        expect(store.get('nonexistent')).toEqual([]);
    });

    it('overwrites previous data on update', () => {
        const store = useVuStore();
        store.update('mic-1', [-12, -15]);
        store.update('mic-1', [-6, -8]);
        expect(store.get('mic-1')).toEqual([-6, -8]);
    });

    it('tracks multiple instances independently', () => {
        const store = useVuStore();
        store.update('mic-1', [-12]);
        store.update('enc-1', [-3, -5]);
        expect(store.get('mic-1')).toEqual([-12]);
        expect(store.get('enc-1')).toEqual([-3, -5]);
    });

    it('clears a single instance', () => {
        const store = useVuStore();
        store.update('mic-1', [-12]);
        store.update('enc-1', [-3]);
        store.clear('mic-1');
        expect(store.get('mic-1')).toEqual([]);
        expect(store.get('enc-1')).toEqual([-3]);
    });

    it('clears all instances', () => {
        const store = useVuStore();
        store.update('mic-1', [-12]);
        store.update('enc-1', [-3]);
        store.clearAll();
        expect(store.get('mic-1')).toEqual([]);
        expect(store.get('enc-1')).toEqual([]);
    });

    it('zeros stale VU data after 1500ms without update', () => {
        const store = useVuStore();
        // VU levels are linear (0-1 range) — must have values > 0 to trigger zeroing
        store.update('mic-1', [0.5, 0.3]);

        // Advance past STALE_MS (1500) + cleanup interval (500)
        vi.advanceTimersByTime(2000);

        expect(store.get('mic-1')).toEqual([0, 0]);
    });

    it('does not zero data that is still fresh', () => {
        const store = useVuStore();
        store.update('mic-1', [0.5, 0.3]);

        // Advance 1000ms — within the 1500ms window
        vi.advanceTimersByTime(1000);

        expect(store.get('mic-1')).toEqual([0.5, 0.3]);
    });

    it('does not zero data that is already all zeros', () => {
        const store = useVuStore();
        store.update('mic-1', [0, 0]);

        vi.advanceTimersByTime(2000);

        // Should remain [0, 0] — no unnecessary re-write
        expect(store.get('mic-1')).toEqual([0, 0]);
    });

    it('resets staleness timer on fresh update', () => {
        const store = useVuStore();
        store.update('mic-1', [0.5, 0.3]);

        // Advance 1200ms (close to stale)
        vi.advanceTimersByTime(1200);

        // Fresh update resets the timer
        store.update('mic-1', [0.4, 0.2]);

        // Advance another 1000ms — still within 1500ms of the fresh update
        vi.advanceTimersByTime(1000);

        expect(store.get('mic-1')).toEqual([0.4, 0.2]);
    });

    it('levels is reactive', () => {
        const store = useVuStore();
        store.update('mic-1', [-12]);
        expect(store.levels['mic-1']).toEqual([-12]);
    });
});

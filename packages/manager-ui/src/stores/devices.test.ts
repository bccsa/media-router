/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDeviceStore } from './devices';

describe('useDeviceStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    describe('rename', () => {
        it('moves every `${engineId}::*` entry to the new id', () => {
            const store = useDeviceStore();
            store.set('old-id', 'audio-source', [{ id: 'hw:0', label: 'Mic' } as any]);
            store.set('old-id', 'audio-sink', [{ id: 'hw:1', label: 'Speaker' } as any]);
            store.set('other-engine', 'audio-source', [{ id: 'hw:9', label: 'Other' } as any]);

            store.rename('old-id', 'new-id');

            expect(store.get('new-id', 'audio-source')).toEqual([{ id: 'hw:0', label: 'Mic' }]);
            expect(store.get('new-id', 'audio-sink')).toEqual([{ id: 'hw:1', label: 'Speaker' }]);
            // Old keys must be cleared, otherwise a future engine reclaiming
            // `old-id` would see ghost device lists from this rename.
            expect(store.get('old-id', 'audio-source')).toEqual([]);
            expect(store.get('old-id', 'audio-sink')).toEqual([]);
            // Other engines' device lists must not be touched.
            expect(store.get('other-engine', 'audio-source')).toEqual([
                { id: 'hw:9', label: 'Other' },
            ]);
        });

        it('is a no-op when old and new ids match', () => {
            const store = useDeviceStore();
            store.set('eng-1', 'audio-source', [{ id: 'hw:0' } as any]);
            store.rename('eng-1', 'eng-1');
            expect(store.get('eng-1', 'audio-source')).toEqual([{ id: 'hw:0' }]);
        });

        it('is a no-op on unknown engine', () => {
            const store = useDeviceStore();
            expect(() => store.rename('unknown', 'new-id')).not.toThrow();
            expect(store.get('new-id', 'audio-source')).toEqual([]);
        });
    });
});

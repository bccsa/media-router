/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEngineGroupsStore } from './engineGroups';

describe('useEngineGroupsStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    describe('setAll', () => {
        it('normalises snake_case server rows into camelCase state', () => {
            const store = useEngineGroupsStore();
            store.setAll([
                {
                    id: 'g1',
                    name: 'Studio',
                    sort_order: 2,
                    collapsed: 1,
                    is_default: 0,
                    color: '#10b981',
                },
            ]);
            const g = store.groups.get('g1');
            expect(g).toEqual({
                id: 'g1',
                name: 'Studio',
                sortOrder: 2,
                collapsed: true,
                isDefault: false,
                color: '#10b981',
            });
        });

        it('replaces the entire set on each call', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'a', name: 'A', sort_order: 0 }]);
            store.setAll([{ id: 'b', name: 'B', sort_order: 0 }]);
            expect(store.groups.size).toBe(1);
            expect(store.groups.has('a')).toBe(false);
            expect(store.groups.has('b')).toBe(true);
        });

        it('treats missing color and is_default as null/false', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'g1', name: 'G', sort_order: 0 }]);
            const g = store.groups.get('g1')!;
            expect(g.color).toBeNull();
            expect(g.isDefault).toBe(false);
            expect(g.collapsed).toBe(false);
        });
    });

    describe('groupList', () => {
        it('returns groups sorted ascending by sortOrder', () => {
            const store = useEngineGroupsStore();
            store.setAll([
                { id: 'c', name: 'C', sort_order: 2 },
                { id: 'a', name: 'A', sort_order: 0 },
                { id: 'b', name: 'B', sort_order: 1 },
            ]);
            expect(store.groupList.map((g) => g.id)).toEqual(['a', 'b', 'c']);
        });
    });

    describe('upsertFromRow', () => {
        it('inserts a new group when id is unseen', () => {
            const store = useEngineGroupsStore();
            store.upsertFromRow({ id: 'new', name: 'New', sort_order: 0 });
            expect(store.groups.get('new')?.name).toBe('New');
        });

        it('replaces an existing group in place', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'g1', name: 'Old', sort_order: 0, color: null }]);
            store.upsertFromRow({ id: 'g1', name: 'New', sort_order: 0, color: '#ef4444' });
            expect(store.groups.get('g1')?.name).toBe('New');
            expect(store.groups.get('g1')?.color).toBe('#ef4444');
            expect(store.groups.size).toBe(1);
        });
    });

    describe('removeGroup', () => {
        it('removes a known group', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'g1', name: 'G', sort_order: 0 }]);
            store.removeGroup('g1');
            expect(store.groups.has('g1')).toBe(false);
        });

        it('is a no-op for unknown ids', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'g1', name: 'G', sort_order: 0 }]);
            store.removeGroup('nope');
            expect(store.groups.size).toBe(1);
        });
    });

    describe('applyOrder', () => {
        it('renumbers sort_order by index of orderedIds', () => {
            const store = useEngineGroupsStore();
            store.setAll([
                { id: 'a', name: 'A', sort_order: 0 },
                { id: 'b', name: 'B', sort_order: 1 },
                { id: 'c', name: 'C', sort_order: 2 },
            ]);
            store.applyOrder(['c', 'a', 'b']);
            expect(store.groups.get('c')?.sortOrder).toBe(0);
            expect(store.groups.get('a')?.sortOrder).toBe(1);
            expect(store.groups.get('b')?.sortOrder).toBe(2);
            expect(store.groupList.map((g) => g.id)).toEqual(['c', 'a', 'b']);
        });

        it('ignores unknown ids in the order list', () => {
            const store = useEngineGroupsStore();
            store.setAll([{ id: 'a', name: 'A', sort_order: 0 }]);
            store.applyOrder(['missing', 'a']);
            // 'a' should still be in the store with sortOrder=1 (its index).
            expect(store.groups.get('a')?.sortOrder).toBe(1);
        });
    });
});

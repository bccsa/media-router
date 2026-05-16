import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export interface EngineGroupState {
    id: string;
    name: string;
    sortOrder: number;
    collapsed: boolean;
    isDefault: boolean;
    /** Optional accent color (hex). `null` when the operator chose "no color". */
    color: string | null;
}

/**
 * Sidebar grouping for engines. Backed by the `engine_groups` SQLite table on
 * the manager — every change round-trips via REST and broadcasts back over
 * Socket.IO, so every browser stays in sync.
 *
 * Shape coming off the wire is snake_case (`sort_order`, `is_default`) — the
 * `fromRow` helper normalises it once so consumers can think in camelCase.
 */
export const useEngineGroupsStore = defineStore('engineGroups', () => {
    const groups = ref<Map<string, EngineGroupState>>(new Map());

    const groupList = computed(() =>
        Array.from(groups.value.values()).sort((a, b) => a.sortOrder - b.sortOrder),
    );

    function fromRow(row: Record<string, unknown>): EngineGroupState {
        return {
            id: row.id as string,
            name: row.name as string,
            sortOrder: (row.sort_order as number) ?? 0,
            collapsed: !!(row.collapsed as number),
            isDefault: !!(row.is_default as number),
            color: (row.color as string | null) ?? null,
        };
    }

    function setAll(rows: Array<Record<string, unknown>>) {
        const next = new Map<string, EngineGroupState>();
        for (const row of rows) {
            const g = fromRow(row);
            next.set(g.id, g);
        }
        groups.value = next;
    }

    function upsertFromRow(row: Record<string, unknown>) {
        const g = fromRow(row);
        groups.value.set(g.id, g);
        groups.value = new Map(groups.value);
    }

    function removeGroup(groupId: string) {
        if (groups.value.delete(groupId)) {
            groups.value = new Map(groups.value);
        }
    }

    function applyOrder(orderedIds: string[]) {
        let changed = false;
        orderedIds.forEach((id, i) => {
            const g = groups.value.get(id);
            if (g && g.sortOrder !== i) {
                groups.value.set(id, { ...g, sortOrder: i });
                changed = true;
            }
        });
        if (changed) groups.value = new Map(groups.value);
    }

    return { groups, groupList, setAll, upsertFromRow, removeGroup, applyOrder };
});

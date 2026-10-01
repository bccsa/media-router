/**
 * Sidebar grouping + ordering: tree writes under `/groups` and
 * `/engines/<id>/info`. Every browser sees the result through its `/groups`
 * and `/engines/+/info` subscriptions.
 */
import type { PatchOp } from '@media-router/shared-types';
import { useSocketStore } from '@/stores/socket';

interface ReorderEnginesUpdate {
    engineId: string;
    groupId: string;
    sortOrder: number;
}

function write(ops: PatchOp[]) {
    return useSocketStore().writeOrThrow(ops);
}

/** Same shape the manager used to mint: `grp_<time36>_<rand6>`. */
function newGroupId(): string {
    return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const engineGroupsApi = {
    async create(name: string, color?: string | null) {
        const id = newGroupId();
        await write([{ op: 'add', path: `/groups/${id}`, value: { name, ...(color ? { color } : {}) } }]);
        return { id };
    },
    update(groupId: string, fields: { name?: string; collapsed?: boolean; color?: string | null }) {
        return write(
            Object.entries(fields)
                .filter(([, v]) => v !== undefined)
                .map(([field, value]) => ({ op: 'replace' as const, path: `/groups/${groupId}/${field}`, value })),
        );
    },
    remove(groupId: string) {
        return write([{ op: 'remove', path: `/groups/${groupId}` }]);
    },
    reorderGroups(orderedIds: string[]) {
        return write(orderedIds.map((id, i) => ({ op: 'replace' as const, path: `/groups/${id}/sort_order`, value: i })));
    },
    reorderEngines(updates: ReorderEnginesUpdate[]) {
        return write(
            updates.flatMap((u) => [
                { op: 'replace' as const, path: `/engines/${u.engineId}/info/groupId`, value: u.groupId },
                { op: 'replace' as const, path: `/engines/${u.engineId}/info/sortOrder`, value: u.sortOrder },
            ]),
        );
    },
};

export type EngineGroupsApi = typeof engineGroupsApi;

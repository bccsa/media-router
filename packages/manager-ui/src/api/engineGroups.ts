/**
 * Sidebar grouping + ordering operations.
 *
 * Routes through Socket.IO RPC (`engine-group:*` / `engine:reorder` events on
 * the manager). The manager's success ack carries no data for mutations —
 * state propagation reaches every browser via the matching broadcast event
 * (`engine-group:added`, `engine-group:updated`, etc.), which the socket
 * store applies to the relevant Pinia store.
 */
import { useSocketStore } from '@/stores/socket';

interface ReorderEnginesUpdate {
    engineId: string;
    groupId: string;
    sortOrder: number;
}

export const engineGroupsApi = {
    create(name: string, color?: string | null) {
        return useSocketStore().request<{ id: string }>('engine-group:create', {
            name,
            color: color ?? undefined,
        });
    },
    update(
        groupId: string,
        fields: { name?: string; collapsed?: boolean; color?: string | null },
    ) {
        return useSocketStore().request('engine-group:update', { groupId, ...fields });
    },
    remove(groupId: string) {
        return useSocketStore().request('engine-group:delete', { groupId });
    },
    reorderGroups(orderedIds: string[]) {
        return useSocketStore().request('engine-group:reorder', { orderedIds });
    },
    reorderEngines(updates: ReorderEnginesUpdate[]) {
        return useSocketStore().request('engine:reorder', { updates });
    },
};

export type EngineGroupsApi = typeof engineGroupsApi;

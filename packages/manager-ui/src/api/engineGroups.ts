/**
 * Thin REST wrappers for the sidebar grouping endpoints. Centralised here so
 * the sidebar and any future caller share one shape, and so the URL set is
 * easy to audit. All endpoints broadcast a Socket.IO event on success — the
 * caller doesn't need to mutate stores; the socket layer does it for free.
 */

interface ReorderEnginesUpdate {
    engineId: string;
    groupId: string;
    sortOrder: number;
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
    return fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
}

export const engineGroupsApi = {
    create(name: string, color?: string | null) {
        return send('/api/v1/engine-groups', 'POST', { name, color: color ?? undefined });
    },
    update(groupId: string, fields: { name?: string; collapsed?: boolean; color?: string | null }) {
        return send(`/api/v1/engine-groups/${groupId}`, 'PUT', fields);
    },
    remove(groupId: string) {
        return send(`/api/v1/engine-groups/${groupId}`, 'DELETE');
    },
    reorderGroups(orderedIds: string[]) {
        return send('/api/v1/engine-groups/reorder', 'PUT', { orderedIds });
    },
    reorderEngines(updates: ReorderEnginesUpdate[]) {
        return send('/api/v1/engines/reorder', 'PUT', { updates });
    },
};

export type EngineGroupsApi = typeof engineGroupsApi;

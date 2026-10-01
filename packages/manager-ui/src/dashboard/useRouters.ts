import { computed } from 'vue';
import { useSubscription } from './useValue';
import type { DashboardSource } from './source';

export interface RouterRef {
    id: string;
    name: string;
    /** The routing view's group it sits in. */
    group: string;
}
export interface RouterGroup {
    id: string;
    name: string;
    color?: string;
    routers: RouterRef[];
}

type EngineRow = { info?: { name?: string; groupId?: string; sortOrder?: number } };
type GroupRow = { name?: string; color?: string; sort_order?: number };

/** The manager's routers in the routing view's groups and order (manager dashboards' pickers). */
export function useRouters(source: DashboardSource, enabled: () => boolean) {
    useSubscription(source, () =>
        enabled() ? ['/engines/+/info/name', '/engines/+/info/groupId', '/engines/+/info/sortOrder', '/groups'] : [],
    );
    const groups = computed<RouterGroup[]>(() => {
        const engines = source.get<Record<string, EngineRow>>('/engines') ?? {};
        const known = source.get<Record<string, GroupRow>>('/groups') ?? {};
        const byGroup = new Map<string, Array<{ id: string; name: string; order: number }>>();
        for (const [id, e] of Object.entries(engines)) {
            const gid = e.info?.groupId && known[e.info.groupId] ? e.info.groupId : 'ungrouped';
            if (!byGroup.has(gid)) byGroup.set(gid, []);
            byGroup.get(gid)!.push({ id, name: e.info?.name || id, order: e.info?.sortOrder ?? 0 });
        }
        return [...byGroup.entries()]
            .map(([gid, rows]) => {
                const g = known[gid] ?? {};
                const name = g.name || 'Ungrouped';
                return {
                    id: gid,
                    name,
                    color: g.color,
                    order: g.sort_order ?? Number.MAX_SAFE_INTEGER,
                    routers: rows
                        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
                        .map((r) => ({ id: r.id, name: r.name, group: name })),
                };
            })
            .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
            .map(({ order: _order, ...g }) => g);
    });
    /** For MrSelect: grouped options. */
    const options = computed(() => groups.value.flatMap((g) => g.routers.map((r) => ({ value: r.id, label: r.name, group: g.name }))));
    return { groups, options };
}

import { computed, type ComputedRef } from 'vue';
import type { ModuleMeta, ValueDescriptor } from '@media-router/shared-types';
import { moduleEntries, routerEntries, type ValueEntry } from '../entries';
import { useSubscription } from '../useValue';
import type { DashboardSource } from '../source';

export interface ModuleItem {
    id: string;
    name: string;
    pluginId: string;
}

/**
 * The modules of one router, for pickers. `base` is where that router sits
 * in the dashboard's own paths: '' on a router dashboard, `/engines/<id>` on
 * a manager dashboard; data is read at `source.prefix + base`.
 */
export function useModules(source: DashboardSource, base: () => string | null): ComputedRef<ModuleItem[]> {
    const at = computed(() => (base() === null ? null : source.prefix + base()));
    useSubscription(source, () => (at.value === null ? [] : [`${at.value}/modules/+/displayName`, `${at.value}/modules/+/pluginId`]));
    return computed(() =>
        Object.entries((at.value === null ? undefined : source.get<Record<string, any>>(`${at.value}/modules`)) ?? {})
            .map(([id, m]) => ({ id, name: (m?.displayName as string) || id, pluginId: (m?.pluginId as string) ?? '' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    );
}

/** What one module (or, with `moduleId` 'router', the router itself) offers to bind. */
export function useEntries(source: DashboardSource, base: () => string | null, moduleId: () => string | null): ComputedRef<ValueEntry[]> {
    const at = computed(() => {
        const id = moduleId();
        if (!id || base() === null) return null;
        return id === 'router' ? `${source.prefix}${base()}/info/running` : `${source.prefix}${base()}/modules/${id}`;
    });
    useSubscription(source, () => (at.value ? [at.value, `/meta${at.value}`] : []));
    return computed(() => {
        const id = moduleId();
        const b = base();
        if (!id || !at.value || b === null) return [];
        if (id === 'router') return routerEntries(b, source.get<ValueDescriptor>(`/meta${at.value}`));
        return moduleEntries(`${b}/modules/${id}`, source.get<ModuleMeta>(`/meta${at.value}`), source.get<Record<string, any>>(at.value));
    });
}

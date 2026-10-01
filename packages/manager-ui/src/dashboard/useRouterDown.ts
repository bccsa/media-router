import { computed, type ComputedRef } from 'vue';
import { useSubscription } from './useValue';
import { onlinePathOf } from './paths';
import type { DashboardSource } from './source';

// Through the manager each widget's router may be down on its own.

/** The router a manager-tree path names says it is offline (unknown = not down). */
export function routerIsDown(source: DashboardSource, path: string | undefined): boolean {
    const online = onlinePathOf(path);
    return !!online && source.get(online) === false;
}

/** `routerIsDown` for a path that may change, subscribed. */
export function useRouterDown(source: DashboardSource, path: () => string | undefined): ComputedRef<boolean> {
    useSubscription(source, () => {
        const online = onlinePathOf(path());
        return online ? [online] : [];
    });
    return computed(() => routerIsDown(source, path()));
}

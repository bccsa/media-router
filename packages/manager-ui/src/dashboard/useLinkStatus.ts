import { computed, type ComputedRef } from 'vue';
import type { Dashboard } from '@media-router/shared-types';
import { useSubscription } from './useValue';
import { namePathOf, onlinePathOf, routersOf } from './paths';
import { routerIsDown } from './useRouterDown';
import type { DashboardSource } from './source';

export type LinkLevel = 'ok' | 'degraded' | 'down';
export interface LinkStatus {
    level: LinkLevel;
    reason: string;
}

/**
 * The dashboard's connection dot (ADR-0026): green = all connected, amber =
 * usable but degraded (a router's own screen without its manager, or some of
 * a manager dashboard's routers offline), red = no input at all.
 */
export function useLinkStatus(opts: {
    source: DashboardSource;
    dashboard: () => Dashboard;
    /** The router behind the source is known to be down. */
    offline: () => boolean;
    /** Served by the router itself (`:8081/d/`). */
    router: () => boolean;
}): ComputedRef<LinkStatus> {
    const { source } = opts;
    // A manager dashboard: absolute paths, one or more routers.
    const routers = computed(() => (!opts.router() && source.prefix === '' ? routersOf(opts.dashboard()) : []));
    useSubscription(source, () =>
        opts.router() ? ['/info/managerLink'] : routers.value.flatMap((id) => [onlinePathOf(`/engines/${id}`)!, namePathOf(id)]),
    );

    return computed(() => {
        if (!source.connected.value) {
            return { level: 'down', reason: opts.router() ? 'Not connected to the router.' : 'Not connected to the manager.' };
        }
        if (opts.offline()) return { level: 'down', reason: 'The router is offline.' };
        if (opts.router()) {
            const link = source.get<{ connected?: boolean }>('/info/managerLink');
            return link?.connected === false
                ? { level: 'degraded', reason: 'Manager unreachable: this screen still works; changes are kept on the router and sent when it is back.' }
                : { level: 'ok', reason: 'Connected to the router and its manager.' };
        }
        const down = routers.value
            .filter((id) => routerIsDown(source, `/engines/${id}`))
            .map((id) => source.get<string>(namePathOf(id)) || id);
        return down.length > 0
            ? { level: 'degraded', reason: `Offline: ${down.join(', ')}. ${down.length > 1 ? 'Their' : 'Its'} widgets show Stale.` }
            : { level: 'ok', reason: 'Connected.' };
    });
}

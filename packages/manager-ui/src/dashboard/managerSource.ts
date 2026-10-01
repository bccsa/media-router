import { createSource, type DashboardSource } from './source';

let shared: DashboardSource | null = null;

/** One manager tree connection for every dashboard page, kept for the session (ADR-0026). */
export function managerSource(): DashboardSource {
    return (shared ??= createSource({ prefix: '' }));
}

/** The same connection seen from one router: router-relative paths go under `/engines/<id>`. */
export function routerScope(engineId: string): DashboardSource {
    return { ...managerSource(), prefix: `/engines/${engineId}` };
}

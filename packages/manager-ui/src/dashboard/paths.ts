// Where a dashboard path points: router, module, router-relative form.
import * as wire from '@media-router/shared-types/browser';
import type { Dashboard } from '@media-router/shared-types';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { widgetPaths } = wire;

const ROUTER_PATH = /^\/engines\/([^/]+)(\/.*)?$/;

/** The router a manager-tree path names (`/engines/<id>/…`). */
export const routerOf = (path: string | undefined): string | undefined => (path ? ROUTER_PATH.exec(path)?.[1] : undefined);

/** `/engines/<id>/x` → `/x`; router-relative paths unchanged. */
export function routerRelative(path: string): string {
    const m = ROUTER_PATH.exec(path);
    return m ? (m[2] ?? '/') : path;
}

/** Where a router's name is, by id. */
export const namePathOf = (id: string): string => `/engines/${id}/info/name`;

/** The last segment of a path (`/modules/m1/settings/volume` → `volume`). */
export const lastSegment = (p?: string): string | undefined => p?.split('/').filter(Boolean).at(-1);

/** Where a manager-tree path's router says whether it is online. */
export function onlinePathOf(path: string | undefined): string | undefined {
    const id = routerOf(path);
    return id ? `/engines/${id}/info/online` : undefined;
}

/** The module a path is on or under (`/modules/m1`, `/engines/e/modules/m1`). */
export const moduleOf = (path: string): string | undefined => /^(.*\/modules\/[^/]+)(?:\/|$)/.exec(path)?.[1];

/** The id of the module a path is on or under. */
export const moduleIdOf = (path: string): string | undefined => /\/modules\/([^/]+)(?:\/|$)/.exec(path)?.[1];

/** The routers a manager dashboard's widgets use, by id: values, actions and script steps. */
export function routersOf(dashboard: Dashboard): string[] {
    const ids = dashboard.widgets.flatMap(widgetPaths).map(routerOf);
    return [...new Set(ids.filter((id): id is string => !!id))];
}

/** The dashboard a viewer URL names (`/d/<name>`, URL-encoded), or null for the list. */
export function viewerName(pathname: string, base = '/d/'): string | null {
    const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, '') : '';
    return rest ? decodeURIComponent(rest) : null;
}


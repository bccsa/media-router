import type { DashboardWidget } from './dashboard.js';
import { scriptPaths } from './script.js';

// Zod-free (the router's viewer bundles `shared-types/browser`, ADR-0026).

/** Every tree path a widget reads or acts on. */
export function widgetPaths(w: DashboardWidget): string[] {
    return [
        ...(w.bind ? [w.bind] : []),
        ...(w.binds ?? []),
        ...(w.action ? [w.action.path] : []),
        ...(w.script ? scriptPaths(w.script.steps) : []),
    ];
}

/** A router-relative path under `prefix` (`/engines/<id>` through the manager, '' on the router); `/` is the router itself. */
export const absolutePath = (prefix: string, rel: string): string => (rel === '/' ? prefix || '/' : prefix + rel);


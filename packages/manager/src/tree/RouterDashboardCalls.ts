import { z } from 'zod';
import { EngineIdSchema, copyDashboard, dashboardsOf, findDashboard, joinPath, type Dashboard, type PatchOp } from '@media-router/shared-types';
import { TreeCallError, type TreeCaller } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { PatchRouter } from '../PatchRouter.js';
import { args } from './callArgs.js';
import { SaveArgs, checkSave, newDashboardId, parseDashboard } from './dashboardCommon.js';

const Copy = z.object({
    toEngine: EngineIdSchema,
    toProfile: z.string().min(1),
    name: z.string().trim().min(1).max(64),
    /** Source module id → target module id. */
    modules: z.record(z.string(), z.string()),
});

export interface RouterDashboardDeps {
    configStore: ConfigStore;
    patchRouter: PatchRouter;
}

/**
 * Router dashboards (ADR-0026) live in the profile. The active profile's go
 * through the patch router like any edit, so the router and every tree
 * subscriber get them; another profile's are only stored.
 */
export class RouterDashboardCalls {
    constructor(private readonly d: RouterDashboardDeps) {}

    handle(caller: TreeCaller, engineId: string, id: string | undefined, method: string, raw: unknown): unknown {
        if (id === undefined && method === 'save') return this.save(caller, engineId, args(SaveArgs, raw));
        if (id !== undefined && method === 'delete') return this.remove(caller, engineId, id);
        if (id !== undefined && method === 'copy') return this.copy(caller, engineId, id, args(Copy, raw));
        throw new TreeCallError(`no method ${method} on dashboards`);
    }

    private active(engineId: string): { profile: string; dashboards: Record<string, Dashboard> } {
        const profile = this.d.configStore.getEngine(engineId)?.active_profile as string | undefined;
        const config = profile ? this.d.configStore.getProfile(engineId, profile) : undefined;
        if (!profile || !config) throw new TreeCallError('No active profile');
        return { profile, dashboards: dashboardsOf(config) };
    }

    private save(caller: TreeCaller, engineId: string, a: SaveArgs): { id: string; rev: number } {
        const dashboard = parseDashboard(a.dashboard);
        const { id, rev, exists } = checkSave(a, this.active(engineId).dashboards, dashboard);
        this.apply(caller, engineId, [{ op: exists ? 'replace' : 'add', path: joinPath(['dashboards', id]), value: { ...dashboard, rev } }]);
        return { id, rev };
    }

    private remove(caller: TreeCaller, engineId: string, id: string): Record<string, never> {
        if (!this.active(engineId).dashboards[id]) throw new TreeCallError('Dashboard not found');
        this.apply(caller, engineId, [{ op: 'remove', path: joinPath(['dashboards', id]) }]);
        return {};
    }

    private copy(caller: TreeCaller, engineId: string, id: string, a: z.infer<typeof Copy>): { id: string } {
        const { configStore } = this.d;
        const source = this.active(engineId).dashboards[id];
        if (!source) throw new TreeCallError('Dashboard not found');
        const target = configStore.getProfile(a.toEngine, a.toProfile);
        if (!target) throw new TreeCallError('Target profile not found');
        if (findDashboard(dashboardsOf(target), a.name)) throw new TreeCallError(`A dashboard named "${a.name}" already exists there`);
        const paths = Object.fromEntries(Object.entries(a.modules).map(([from, to]) => [`/modules/${from}`, `/modules/${to}`]));
        const copy = { ...parseDashboard(copyDashboard(source, a.name, paths)), rev: 1 };
        const newId = newDashboardId();
        if (configStore.getEngine(a.toEngine)?.active_profile === a.toProfile) {
            this.apply(caller, a.toEngine, [{ op: 'add', path: joinPath(['dashboards', newId]), value: copy }]);
        } else {
            configStore.modifyProfileConfig(a.toEngine, a.toProfile, (cfg) => ({ ...cfg, dashboards: { ...dashboardsOf(cfg), [newId]: copy } }));
        }
        return { id: newId };
    }

    private apply(caller: TreeCaller, engineId: string, ops: PatchOp[]): void {
        const dropped = this.d.patchRouter.onPatch(caller.socketId, engineId, ops);
        if (dropped.length > 0) throw new TreeCallError(`Not applied: ${dropped.map((i) => ops[i].path).join(', ')}`);
    }
}

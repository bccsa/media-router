import { z } from 'zod';
import { joinPath, rebindWidget, type Dashboard } from '@media-router/shared-types';
import { TreeCallError } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { TreePublisher } from './TreePublisher.js';
import { Rollback, args } from './callArgs.js';
import { SaveArgs, checkSave, newDashboardId, parseDashboard } from './dashboardCommon.js';

const Duplicate = z.object({ name: z.string().trim().min(1).max(64) });

export interface ManagerDashboardDeps {
    configStore: ConfigStore;
    publisher: TreePublisher;
}

/**
 * Manager dashboards (ADR-0026): they mix routers, so their paths are
 * absolute (`/engines/<id>/…`); the manager stores and serves them, with the
 * same version history as profiles.
 */
export class ManagerDashboardCalls {
    constructor(private readonly d: ManagerDashboardDeps) {}

    handle(id: string | undefined, method: string, raw: unknown): unknown {
        if (id === undefined) {
            if (method === 'save') return this.save(args(SaveArgs, raw));
        } else {
            switch (method) {
                case 'delete':
                    return this.remove(id);
                case 'duplicate':
                    return this.duplicate(id, args(Duplicate, raw).name);
                case 'history':
                    this.require(id);
                    return this.d.configStore.getDashboardHistory(id);
                case 'rollback':
                    return this.rollback(id, args(Rollback, raw).versionId);
            }
        }
        throw new TreeCallError(`no method ${method} on dashboards`);
    }

    /** An engine was renamed: its widgets follow it (the revision moves, so open editors see a conflict). */
    renameEngine(oldId: string, newId: string): void {
        const from = joinPath(['engines', oldId]);
        const to = joinPath(['engines', newId]);
        for (const [id, d] of Object.entries(this.d.configStore.getDashboards())) {
            const widgets = d.widgets.map((w) => rebindWidget(w, from, to));
            if (JSON.stringify(widgets) !== JSON.stringify(d.widgets)) this.put(id, { ...d, widgets, rev: (d.rev ?? 0) + 1 }, 'replace');
        }
    }

    private require(id: string): Dashboard {
        const d = this.d.configStore.getDashboard(id);
        if (!d) throw new TreeCallError('Dashboard not found');
        return d;
    }

    private put(id: string, d: Dashboard, op: 'add' | 'replace'): void {
        this.d.configStore.putDashboard(id, d);
        this.d.publisher.publish([{ op, path: joinPath(['dashboards', id]), value: d }]);
    }

    private save(a: SaveArgs): { id: string; rev: number } {
        const dashboard = parseDashboard(a.dashboard);
        const { id, rev, exists } = checkSave(a, this.d.configStore.getDashboards(), dashboard);
        this.put(id, { ...dashboard, rev }, exists ? 'replace' : 'add');
        return { id, rev };
    }

    private remove(id: string): Record<string, never> {
        this.require(id);
        this.d.configStore.deleteDashboard(id);
        this.d.publisher.publish([{ op: 'remove', path: joinPath(['dashboards', id]) }]);
        return {};
    }

    private duplicate(id: string, name: string): { id: string } {
        const { rev: _rev, ...source } = this.require(id);
        const copy = parseDashboard({ ...source, name });
        const { id: newId } = checkSave({ dashboard: copy }, this.d.configStore.getDashboards(), copy);
        this.put(newId, { ...copy, rev: 1 }, 'add');
        return { id: newId };
    }

    private rollback(id: string, versionId: number): { rev: number } {
        const current = this.require(id);
        const version = this.d.configStore.getDashboardVersion(id, versionId);
        if (!version) throw new TreeCallError('Version not found');
        const { rev: _rev, ...body } = version;
        const restored = parseDashboard(body);
        checkSave({ id, dashboard: restored, force: true }, this.d.configStore.getDashboards(), restored);
        const rev = (current.rev ?? 0) + 1;
        this.put(id, { ...restored, rev }, 'replace');
        return { rev };
    }
}

import { z } from 'zod';
import { DashboardSchema, type Dashboard } from '@media-router/shared-types';
import { TreeCallError } from '@media-router/topic-tree';

// What router and manager dashboard calls share (ADR-0026).

export const DashboardId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const SaveArgs = z.object({
    id: DashboardId.optional(),
    dashboard: z.unknown(),
    /** The revision the editor started from; a newer stored one is a conflict. */
    baseRev: z.number().int().nonnegative().optional(),
    force: z.boolean().optional(),
});
export type SaveArgs = z.infer<typeof SaveArgs>;

/** A checked dashboard, or the first problem as the call's error. */
export function parseDashboard(raw: unknown): Dashboard {
    const parsed = DashboardSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    throw new TreeCallError(`invalid dashboard: ${[...issue.path, issue.message].join(' ')}`);
}

export function newDashboardId(): string {
    return `dsh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The checks every save makes: the dashboard is valid, an update targets an
 * existing one whose revision the editor started from (unless forced), and
 * the name is free. Returns the id and the next revision.
 */
export function checkSave(a: SaveArgs, all: Record<string, Dashboard>, dashboard: Dashboard): { id: string; rev: number; exists: boolean } {
    const current = a.id === undefined ? undefined : all[a.id];
    if (a.id !== undefined && !current) throw new TreeCallError('Dashboard not found');
    if (current && !a.force && (current.rev ?? 0) !== (a.baseRev ?? 0)) {
        throw new TreeCallError('Someone else saved this dashboard meanwhile', 'conflict');
    }
    const id = a.id ?? newDashboardId();
    const clash = Object.entries(all).find(([other, d]) => other !== id && d.name === dashboard.name);
    if (clash) throw new TreeCallError(`A dashboard named "${dashboard.name}" already exists`);
    return { id, rev: (current?.rev ?? 0) + 1, exists: !!current };
}

import type Database from 'better-sqlite3';
import { createLogger, isValidDashboard, type Dashboard } from '@media-router/shared-types';
import type { ConfigHistoryRepository } from './ConfigHistoryRepository.js';

const log = createLogger('DashboardRepository');

/**
 * History owner for manager dashboards in `engine_config_history`, with the
 * dashboard id as the profile name. Engine ids start with a letter or digit,
 * so this can never collide with one.
 */
export const DASHBOARD_HISTORY_OWNER = '@dashboards';

/**
 * Owns `manager_dashboards` (ADR-0026): dashboards that mix routers, one JSON
 * row each. Saves feed the same version history as profiles.
 */
export class DashboardRepository {
    constructor(
        private db: Database.Database,
        private history: ConfigHistoryRepository,
    ) {}

    /** Each row's JSON and what it read as (undefined: corrupt or invalid), so a row is checked once. */
    private read = new Map<string, { json: string; d: Dashboard | undefined }>();

    all(): Record<string, Dashboard> {
        const out: Record<string, Dashboard> = {};
        for (const row of this.db.prepare('SELECT id, config FROM manager_dashboards').all() as Array<{ id: string; config: string }>) {
            let hit = this.read.get(row.id);
            if (hit?.json !== row.config) {
                hit = { json: row.config, d: this.parse(row.id, row.config) };
                this.read.set(row.id, hit);
            }
            if (hit.d) out[row.id] = hit.d;
        }
        return out;
    }

    private parse(id: string, json: string): Dashboard | undefined {
        try {
            const d: unknown = JSON.parse(json);
            return isValidDashboard(id, d) ? d : undefined;
        } catch (err) {
            log.error({ err, id }, 'Corrupt dashboard JSON — skipped');
            return undefined;
        }
    }

    get(id: string): Dashboard | undefined {
        return this.all()[id];
    }

    put(id: string, dashboard: Dashboard): void {
        const json = JSON.stringify(dashboard);
        this.db
            .prepare(
                `INSERT INTO manager_dashboards (id, config, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
            )
            .run(id, json);
        this.history.maybeSave(DASHBOARD_HISTORY_OWNER, id, json);
    }

    delete(id: string): void {
        this.db.prepare('DELETE FROM manager_dashboards WHERE id = ?').run(id);
        this.read.delete(id);
        this.history.deleteByProfile(DASHBOARD_HISTORY_OWNER, id);
    }
}

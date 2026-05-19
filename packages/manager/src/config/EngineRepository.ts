import type Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('EngineRepository');

/**
 * Owns the `engines` table. Single-table CRUD only — cross-table cascades
 * (cascading profile + history deletion) live on the `ConfigStore` facade
 * that composes this repo with the profile and history repos.
 */
export class EngineRepository {
    constructor(private db: Database.Database) {}

    create(engineId: string, displayName: string, password: string): void {
        try {
            // New engines go to the end of the "Ungrouped" group.
            const max = (
                this.db
                    .prepare(
                        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM engines WHERE group_id = 'ungrouped'",
                    )
                    .get() as { m: number }
            ).m;
            this.db
                .prepare(
                    "INSERT INTO engines (engine_id, display_name, password, group_id, sort_order) VALUES (?, ?, ?, 'ungrouped', ?)",
                )
                .run(engineId, displayName, password, max + 1);
        } catch (err) {
            log.error({ err, engineId }, 'Failed to create engine');
            throw err;
        }
    }

    get(engineId: string): Record<string, unknown> | undefined {
        return this.db.prepare('SELECT * FROM engines WHERE engine_id = ?').get(engineId) as
            | Record<string, unknown>
            | undefined;
    }

    getAll(): Array<Record<string, unknown>> {
        return this.db
            .prepare('SELECT * FROM engines ORDER BY sort_order ASC, engine_id ASC')
            .all() as Array<Record<string, unknown>>;
    }

    update(engineId: string, displayName: string, password?: string): void {
        try {
            if (password) {
                this.db
                    .prepare(
                        "UPDATE engines SET display_name = ?, password = ?, updated_at = datetime('now') WHERE engine_id = ?",
                    )
                    .run(displayName, password, engineId);
            } else {
                this.db
                    .prepare(
                        "UPDATE engines SET display_name = ?, updated_at = datetime('now') WHERE engine_id = ?",
                    )
                    .run(displayName, engineId);
            }
        } catch (err) {
            log.error({ err, engineId }, 'Failed to update engine');
            throw err;
        }
    }

    delete(engineId: string): void {
        try {
            this.db.prepare('DELETE FROM engines WHERE engine_id = ?').run(engineId);
        } catch (err) {
            log.error({ err, engineId }, 'Failed to delete engine');
            throw err;
        }
    }

    /**
     * Bulk-assign engines to groups + positions. The full updates array is
     * applied in one transaction so a partial failure doesn't leave the list
     * half-reordered.
     */
    reorder(updates: Array<{ engineId: string; groupId: string; sortOrder: number }>): void {
        const txn = this.db.transaction(() => {
            const upd = this.db.prepare(
                "UPDATE engines SET group_id = ?, sort_order = ?, updated_at = datetime('now') WHERE engine_id = ?",
            );
            for (const { engineId, groupId, sortOrder } of updates) {
                upd.run(groupId, sortOrder, engineId);
            }
        });
        try {
            txn();
        } catch (err) {
            log.error({ err }, 'Failed to reorder engines');
            throw err;
        }
    }

    setActiveProfile(engineId: string, profileName: string): void {
        try {
            this.db
                .prepare(
                    "UPDATE engines SET active_profile = ?, updated_at = datetime('now') WHERE engine_id = ?",
                )
                .run(profileName, engineId);
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to set active profile');
            throw err;
        }
    }
}

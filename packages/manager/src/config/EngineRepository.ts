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
     * Rename the primary key, optionally folding a display_name/password
     * change into the same transaction.
     *
     * `engine_profiles` has an FK without ON UPDATE CASCADE (sqlite
     * ALTER TABLE can't add it after the fact), so we update all three tables
     * manually. `defer_foreign_keys` defers FK checking until COMMIT so the
     * parent UPDATE doesn't fire a transient FK violation against
     * engine_profiles rows that we're about to repoint in the same
     * transaction — better-sqlite3 enables `PRAGMA foreign_keys = ON` by
     * default and would otherwise reject the parent update.
     *
     * Folding the metadata update in: rename is an HTTP operation that also
     * carries an updated display name (and optionally a new password). Doing
     * those as a separate UPDATE after rename would let the rename commit
     * while the metadata change still throws — leaving the UI keyed by the
     * old id (no rename event was emitted yet) and the row under the new id
     * with stale fields. One transaction = either both land or neither does.
     *
     * Caller must ensure `newId` is unique — the underlying PK constraint
     * will throw otherwise, the transaction rolls back, and nothing changes.
     */
    rename(
        oldId: string,
        newId: string,
        meta?: { displayName?: string; password?: string },
    ): void {
        // Build the parent UPDATE dynamically so display_name and password can
        // be set independently — earlier versions required `displayName` to be
        // present before either would land, which silently dropped a
        // password-only rename.
        const setClauses = ['engine_id = ?', "updated_at = datetime('now')"];
        const params: unknown[] = [newId];
        if (meta?.displayName !== undefined) {
            setClauses.push('display_name = ?');
            params.push(meta.displayName);
        }
        if (meta?.password) {
            setClauses.push('password = ?');
            params.push(meta.password);
        }
        params.push(oldId);
        const parentUpdate = `UPDATE engines SET ${setClauses.join(', ')} WHERE engine_id = ?`;

        const txn = this.db.transaction(() => {
            this.db.pragma('defer_foreign_keys = 1');
            this.db.prepare(parentUpdate).run(...params);
            this.db
                .prepare('UPDATE engine_profiles SET engine_id = ? WHERE engine_id = ?')
                .run(newId, oldId);
            this.db
                .prepare('UPDATE engine_config_history SET engine_id = ? WHERE engine_id = ?')
                .run(newId, oldId);
        });
        try {
            txn();
        } catch (err) {
            log.error({ err, oldId, newId }, 'Failed to rename engine');
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

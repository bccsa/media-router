import type Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('EngineGroupRepository');

/**
 * Owns the `engine_groups` table. `delete` is the one cross-table operation —
 * it reassigns orphaned engines back to "Ungrouped" inside the same txn so
 * the database is never seen with engines pointing at a vanished group.
 */
export class EngineGroupRepository {
    constructor(private db: Database.Database) {}

    getAll(): Array<Record<string, unknown>> {
        return this.db
            .prepare('SELECT * FROM engine_groups ORDER BY sort_order ASC, id ASC')
            .all() as Array<Record<string, unknown>>;
    }

    get(groupId: string): Record<string, unknown> | undefined {
        return this.db.prepare('SELECT * FROM engine_groups WHERE id = ?').get(groupId) as
            | Record<string, unknown>
            | undefined;
    }

    create(groupId: string, name: string, color?: string | null): void {
        try {
            const max = (
                this.db
                    .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM engine_groups')
                    .get() as { m: number }
            ).m;
            this.db
                .prepare(
                    'INSERT INTO engine_groups (id, name, sort_order, color) VALUES (?, ?, ?, ?)',
                )
                .run(groupId, name, max + 1, color ?? null);
        } catch (err) {
            log.error({ err, groupId }, 'Failed to create group');
            throw err;
        }
    }

    update(
        groupId: string,
        fields: { name?: string; collapsed?: boolean; color?: string | null },
    ): void {
        const sets: string[] = [];
        const values: unknown[] = [];
        if (fields.name !== undefined) {
            sets.push('name = ?');
            values.push(fields.name);
        }
        if (fields.collapsed !== undefined) {
            sets.push('collapsed = ?');
            values.push(fields.collapsed ? 1 : 0);
        }
        if (fields.color !== undefined) {
            sets.push('color = ?');
            // null clears the accent — `undefined` would skip the field instead.
            values.push(fields.color);
        }
        if (!sets.length) return;
        sets.push("updated_at = datetime('now')");
        values.push(groupId);
        try {
            this.db
                .prepare(`UPDATE engine_groups SET ${sets.join(', ')} WHERE id = ?`)
                .run(...values);
        } catch (err) {
            log.error({ err, groupId }, 'Failed to update group');
            throw err;
        }
    }

    /**
     * Delete a non-default group. Engines belonging to it fall back to the
     * "Ungrouped" group, keeping their order relative to each other but
     * appended to the end of Ungrouped.
     */
    delete(groupId: string): void {
        if (groupId === 'ungrouped') {
            throw new Error('Cannot delete the default Ungrouped group');
        }
        const txn = this.db.transaction(() => {
            const max = (
                this.db
                    .prepare(
                        "SELECT COALESCE(MAX(sort_order), -1) AS m FROM engines WHERE group_id = 'ungrouped'",
                    )
                    .get() as { m: number }
            ).m;
            const orphans = this.db
                .prepare(
                    'SELECT engine_id FROM engines WHERE group_id = ? ORDER BY sort_order ASC, engine_id ASC',
                )
                .all(groupId) as Array<{ engine_id: string }>;
            const reassign = this.db.prepare(
                "UPDATE engines SET group_id = 'ungrouped', sort_order = ? WHERE engine_id = ?",
            );
            orphans.forEach((row, i) => reassign.run(max + 1 + i, row.engine_id));
            this.db.prepare('DELETE FROM engine_groups WHERE id = ?').run(groupId);
        });
        try {
            txn();
        } catch (err) {
            log.error({ err, groupId }, 'Failed to delete group');
            throw err;
        }
    }

    /** Bulk-set group ordering. Unknown ids are ignored. */
    reorder(orderedIds: string[]): void {
        const txn = this.db.transaction(() => {
            const upd = this.db.prepare('UPDATE engine_groups SET sort_order = ? WHERE id = ?');
            orderedIds.forEach((id, i) => upd.run(i, id));
        });
        try {
            txn();
        } catch (err) {
            log.error({ err }, 'Failed to reorder groups');
            throw err;
        }
    }
}

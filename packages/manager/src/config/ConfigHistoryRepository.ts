import type Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('ConfigHistoryRepository');

/**
 * Owns the `engine_config_history` table plus the in-memory `versionTimers`
 * debounce map. Version saves are debounced to 10 minutes per
 * `engineId:profileName` key, and the table is pruned to 10 entries per
 * profile on each save.
 */
export class ConfigHistoryRepository {
    private versionTimers = new Map<string, number>();

    constructor(private db: Database.Database) {}

    /**
     * Write a new version snapshot if the last write for this
     * `engineId:profileName` is older than the 10-minute window. Otherwise
     * a no-op — callers fire this on every config write and rely on the
     * debounce to avoid flooding the history table.
     */
    maybeSave(engineId: string, profileName: string, configStr: string): void {
        const key = `${engineId}:${profileName}`;
        const now = Date.now();
        const lastSave = this.versionTimers.get(key) ?? 0;

        if (now - lastSave > 10 * 60 * 1000) {
            this.db
                .prepare(
                    'INSERT INTO engine_config_history (engine_id, profile_name, config) VALUES (?, ?, ?)',
                )
                .run(engineId, profileName, configStr);
            this.versionTimers.set(key, now);

            // Prune to keep max 10 versions per engine/profile
            this.db
                .prepare(
                    `DELETE FROM engine_config_history
                     WHERE engine_id = ? AND profile_name = ?
                     AND id NOT IN (
                         SELECT id FROM engine_config_history
                         WHERE engine_id = ? AND profile_name = ?
                         ORDER BY saved_at DESC LIMIT 10
                     )`,
                )
                .run(engineId, profileName, engineId, profileName);
        }
    }

    list(
        engineId: string,
        profileName: string,
    ): Array<{ id: number; saved_at: string; config: string }> {
        return this.db
            .prepare(
                'SELECT id, saved_at, config FROM engine_config_history WHERE engine_id = ? AND profile_name = ? ORDER BY saved_at DESC LIMIT 10',
            )
            .all(engineId, profileName) as Array<{
            id: number;
            saved_at: string;
            config: string;
        }>;
    }

    getVersion(
        engineId: string,
        profileName: string,
        versionId: number,
    ): Record<string, unknown> | undefined {
        const row = this.db
            .prepare(
                'SELECT config FROM engine_config_history WHERE id = ? AND engine_id = ? AND profile_name = ?',
            )
            .get(versionId, engineId, profileName) as { config: string } | undefined;
        if (!row) return undefined;
        try {
            return JSON.parse(row.config);
        } catch (err) {
            log.error({ err, versionId }, 'Corrupt version config JSON');
            return undefined;
        }
    }

    /** Cascade for `deleteProfile`. */
    deleteByProfile(engineId: string, profileName: string): void {
        this.db
            .prepare(
                'DELETE FROM engine_config_history WHERE engine_id = ? AND profile_name = ?',
            )
            .run(engineId, profileName);
        this.versionTimers.delete(`${engineId}:${profileName}`);
    }

    /** Cascade for `deleteEngine`. */
    deleteByEngine(engineId: string): void {
        this.db.prepare('DELETE FROM engine_config_history WHERE engine_id = ?').run(engineId);
        for (const key of this.versionTimers.keys()) {
            if (key.startsWith(`${engineId}:`)) this.versionTimers.delete(key);
        }
    }

    /** Drop the in-memory debounce state — called from `ConfigStore.close()`. */
    clear(): void {
        this.versionTimers.clear();
    }
}

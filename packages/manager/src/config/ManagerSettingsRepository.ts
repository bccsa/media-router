import type Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('ManagerSettingsRepository');

/**
 * Owns the `manager_settings` table: one JSON value per key. This is where
 * the manager's OWN configuration lives (as opposed to engine config in the
 * other tables) so it survives a RAUC slot swap with the rest of `/data`
 * and is edited from the manager UI like everything else.
 */
export class ManagerSettingsRepository {
    constructor(private db: Database.Database) {}

    get<T>(key: string): T | undefined {
        const row = this.db.prepare('SELECT value FROM manager_settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        if (!row) return undefined;
        try {
            return JSON.parse(row.value) as T;
        } catch (err) {
            log.error({ err, key }, 'Corrupt setting value — ignoring');
            return undefined;
        }
    }

    set(key: string, value: unknown): void {
        this.db
            .prepare(
                `INSERT INTO manager_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(key, JSON.stringify(value));
    }
}

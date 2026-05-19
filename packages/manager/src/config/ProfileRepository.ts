import type Database from 'better-sqlite3';
import { createLogger, coerceArray } from '@media-router/shared-types';
import type { ConfigHistoryRepository } from './ConfigHistoryRepository.js';

const log = createLogger('ProfileRepository');

/**
 * Coerce a loaded profile config into a well-formed shape so callers never see
 * `interlocks: undefined` or (from an earlier applyJsonPatch bug)
 * `interlocks: { "-": {...} }`. Single coercion point — PatchRouter /
 * SocketIOSetup / reconcileInterlocks don't need defensive `Array.isArray`.
 */
function normalizeProfileConfig(config: Record<string, unknown>): Record<string, unknown> {
    config.interlocks = coerceArray(config.interlocks);
    config.connections = coerceArray(config.connections);
    return config;
}

/**
 * Owns the `engine_profiles` table. Writes also trigger version-history saves
 * via the injected `ConfigHistoryRepository`; `delete` cascades through to it.
 */
export class ProfileRepository {
    constructor(
        private db: Database.Database,
        private history: ConfigHistoryRepository,
    ) {}

    create(
        engineId: string,
        profileName: string,
        config: Record<string, unknown> = {},
    ): void {
        try {
            this.db
                .prepare(
                    'INSERT OR IGNORE INTO engine_profiles (engine_id, profile_name, config) VALUES (?, ?, ?)',
                )
                .run(engineId, profileName, JSON.stringify(config));
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to create profile');
            throw err;
        }
    }

    get(engineId: string, profileName: string): Record<string, unknown> | undefined {
        const row = this.db
            .prepare('SELECT config FROM engine_profiles WHERE engine_id = ? AND profile_name = ?')
            .get(engineId, profileName) as { config: string } | undefined;
        if (!row) return undefined;
        try {
            const parsed = JSON.parse(row.config) as Record<string, unknown>;
            return normalizeProfileConfig(parsed);
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Corrupt config JSON in database');
            return {};
        }
    }

    list(engineId: string): Array<{ profile_name: string }> {
        return this.db
            .prepare('SELECT profile_name FROM engine_profiles WHERE engine_id = ?')
            .all(engineId) as Array<{ profile_name: string }>;
    }

    update(engineId: string, profileName: string, config: Record<string, unknown>): void {
        try {
            const configStr = JSON.stringify(config);
            this.db
                .prepare(
                    'UPDATE engine_profiles SET config = ? WHERE engine_id = ? AND profile_name = ?',
                )
                .run(configStr, engineId, profileName);

            this.history.maybeSave(engineId, profileName, configStr);
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to update profile config');
            throw err;
        }
    }

    /**
     * Atomically read, modify, and write a profile config.
     * The modifier receives the current config and returns the modified version.
     * Uses SQLite transaction to guarantee atomicity (future-proof against async).
     */
    modify(
        engineId: string,
        profileName: string,
        modifier: (config: Record<string, unknown>) => Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        const txn = this.db.transaction(() => {
            const row = this.db
                .prepare(
                    'SELECT config FROM engine_profiles WHERE engine_id = ? AND profile_name = ?',
                )
                .get(engineId, profileName) as { config: string } | undefined;
            if (!row) return undefined;

            let config: Record<string, unknown>;
            try {
                config = normalizeProfileConfig(JSON.parse(row.config));
            } catch {
                config = normalizeProfileConfig({});
            }

            const modified = modifier(config);
            const configStr = JSON.stringify(modified);
            this.db
                .prepare(
                    'UPDATE engine_profiles SET config = ? WHERE engine_id = ? AND profile_name = ?',
                )
                .run(configStr, engineId, profileName);
            this.history.maybeSave(engineId, profileName, configStr);
            return modified;
        });

        try {
            return txn();
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to modify profile config');
            return undefined;
        }
    }

    delete(engineId: string, profileName: string): void {
        try {
            this.db
                .prepare('DELETE FROM engine_profiles WHERE engine_id = ? AND profile_name = ?')
                .run(engineId, profileName);
            this.history.deleteByProfile(engineId, profileName);
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to delete profile');
            throw err;
        }
    }

    /** Cascade for `deleteEngine` — remove all profiles for an engine. */
    deleteByEngine(engineId: string): void {
        this.db.prepare('DELETE FROM engine_profiles WHERE engine_id = ?').run(engineId);
    }
}

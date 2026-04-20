import Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('ConfigStore');

/**
 * Coerce a loaded profile config into a well-formed shape so callers never see
 * `interlocks: undefined` or (from an earlier applyJsonPatch bug) `interlocks: { "-": {...} }`.
 * This is the single coercion point — PatchRouter / SocketIOSetup / reconcileInterlocks
 * no longer need defensive `Array.isArray` checks.
 */
function normalizeProfileConfig(config: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(config.interlocks)) {
        const raw = config.interlocks;
        if (raw && typeof raw === 'object') {
            config.interlocks = Object.values(raw as Record<string, unknown>).filter(
                (v): v is Record<string, unknown> =>
                    !!v && typeof v === 'object' && !Array.isArray(v),
            );
        } else {
            config.interlocks = [];
        }
    }
    return config;
}

/**
 * SQLite configuration store for the Manager.
 *
 * Stores engine registrations, named configuration profiles per engine,
 * and config version history with 10-minute debounce.
 */
export class ConfigStore {
    private db: Database.Database;
    private versionTimers = new Map<string, number>(); // engineId:profile → last save timestamp

    constructor(dbPath?: string) {
        if (!dbPath) {
            // Default: persist to ~/.media-router/manager.db
            const os = require('os');
            const path = require('path');
            const fs = require('fs');
            const configDir = path.join(os.homedir(), '.media-router');
            if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
            dbPath = path.join(configDir, 'manager.db');
        }
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.createTables();
        this.seedDefaults();
        log.info({ dbPath }, 'database opened');
    }

    private createTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS engines (
                engine_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                password TEXT NOT NULL,
                active_profile TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS engine_profiles (
                engine_id TEXT NOT NULL,
                profile_name TEXT NOT NULL,
                config TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (engine_id, profile_name),
                FOREIGN KEY (engine_id) REFERENCES engines(engine_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS engine_config_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                engine_id TEXT NOT NULL,
                profile_name TEXT NOT NULL,
                config TEXT NOT NULL,
                saved_at TEXT DEFAULT (datetime('now'))
            );
        `);
    }

    /** Seed database with a default engine + profile on first start. Skips in-memory DBs (tests). */
    private seedDefaults(): void {
        if (this.db.name === ':memory:' || this.db.name === '') return; // Skip for tests
        const count = (this.db.prepare('SELECT COUNT(*) as c FROM engines').get() as { c: number })
            .c;
        if (count > 0) return; // Already has data

        log.info('First start — seeding default engine and profile');

        const engineId = 'local';
        const password = 'media-router';

        // Create default engine
        this.db
            .prepare(
                'INSERT INTO engines (engine_id, display_name, password, active_profile) VALUES (?, ?, ?, ?)',
            )
            .run(engineId, 'Local Engine', password, 'default');

        // Create default profile with Audio Input → Audio Output
        const inputId = `audio-input-${Date.now().toString(36)}`;
        const outputId = `audio-output-${Date.now().toString(36)}a`;

        const config = {
            modules: {
                [inputId]: {
                    pluginId: 'audio-input',
                    displayName: 'Audio Input',
                    enabled: true,
                    position: { x: 100, y: 200 },
                    settings: {
                        device: '',
                        sampleRate: 48000,
                        channels: 2,
                        volume: 100,
                        volumeMax: 150,
                    },
                    ports: [
                        {
                            id: 'audio-out',
                            direction: 'output',
                            streamType: 'audio/pcm',
                            label: 'Audio Out',
                            maxConnections: -1,
                        },
                    ],
                },
                [outputId]: {
                    pluginId: 'audio-output',
                    displayName: 'Audio Output',
                    enabled: true,
                    position: { x: 500, y: 200 },
                    settings: {
                        device: '',
                        sampleRate: 48000,
                        channels: 2,
                        volume: 100,
                        volumeMax: 150,
                    },
                    ports: [
                        {
                            id: 'audio-in',
                            direction: 'input',
                            streamType: 'audio/pcm',
                            label: 'Audio In',
                            maxConnections: -1,
                        },
                    ],
                },
            },
            connections: [
                {
                    id: `${inputId}:audio-out-${outputId}:audio-in`,
                    sourceModuleId: inputId,
                    sourcePortId: 'audio-out',
                    sinkModuleId: outputId,
                    sinkPortId: 'audio-in',
                },
            ],
            interlocks: [],
        };

        this.db
            .prepare(
                'INSERT INTO engine_profiles (engine_id, profile_name, config) VALUES (?, ?, ?)',
            )
            .run(engineId, 'default', JSON.stringify(config));
    }

    // --- Engine CRUD ---

    createEngine(engineId: string, displayName: string, password: string): void {
        try {
            this.db
                .prepare('INSERT INTO engines (engine_id, display_name, password) VALUES (?, ?, ?)')
                .run(engineId, displayName, password);
        } catch (err) {
            log.error({ err, engineId }, 'Failed to create engine');
            throw err;
        }
    }

    getEngine(engineId: string): Record<string, unknown> | undefined {
        return this.db.prepare('SELECT * FROM engines WHERE engine_id = ?').get(engineId) as
            | Record<string, unknown>
            | undefined;
    }

    getAllEngines(): Array<Record<string, unknown>> {
        return this.db.prepare('SELECT * FROM engines').all() as Array<Record<string, unknown>>;
    }

    updateEngine(engineId: string, displayName: string, password?: string): void {
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

    deleteEngine(engineId: string): void {
        try {
            this.db.prepare('DELETE FROM engine_profiles WHERE engine_id = ?').run(engineId);
            this.db.prepare('DELETE FROM engine_config_history WHERE engine_id = ?').run(engineId);
            this.db.prepare('DELETE FROM engines WHERE engine_id = ?').run(engineId);
            for (const key of this.versionTimers.keys()) {
                if (key.startsWith(`${engineId}:`)) this.versionTimers.delete(key);
            }
        } catch (err) {
            log.error({ err, engineId }, 'Failed to delete engine');
            throw err;
        }
    }

    // --- Profile CRUD ---

    createProfile(
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

    getProfile(engineId: string, profileName: string): Record<string, unknown> | undefined {
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

    getProfiles(engineId: string): Array<{ profile_name: string }> {
        return this.db
            .prepare('SELECT profile_name FROM engine_profiles WHERE engine_id = ?')
            .all(engineId) as Array<{ profile_name: string }>;
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

    updateProfileConfig(
        engineId: string,
        profileName: string,
        config: Record<string, unknown>,
    ): void {
        try {
            const configStr = JSON.stringify(config);
            this.db
                .prepare(
                    'UPDATE engine_profiles SET config = ? WHERE engine_id = ? AND profile_name = ?',
                )
                .run(configStr, engineId, profileName);

            // Save version with 10-minute debounce
            this.maybeSaveVersion(engineId, profileName, configStr);
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
    modifyProfileConfig(
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
            this.maybeSaveVersion(engineId, profileName, configStr);
            return modified;
        });

        try {
            return txn();
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to modify profile config');
            return undefined;
        }
    }

    deleteProfile(engineId: string, profileName: string): void {
        try {
            this.db
                .prepare('DELETE FROM engine_profiles WHERE engine_id = ? AND profile_name = ?')
                .run(engineId, profileName);
            // Cascade: remove version history and timer for this profile
            this.db
                .prepare(
                    'DELETE FROM engine_config_history WHERE engine_id = ? AND profile_name = ?',
                )
                .run(engineId, profileName);
            this.versionTimers.delete(`${engineId}:${profileName}`);
        } catch (err) {
            log.error({ err, engineId, profileName }, 'Failed to delete profile');
            throw err;
        }
    }

    // --- Version History ---

    private maybeSaveVersion(engineId: string, profileName: string, configStr: string): void {
        const key = `${engineId}:${profileName}`;
        const now = Date.now();
        const lastSave = this.versionTimers.get(key) ?? 0;

        // 10-minute debounce
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

    getVersionHistory(
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

    // --- Lifecycle ---

    close(): void {
        this.versionTimers.clear();
        this.db.close();
    }
}

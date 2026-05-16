import Database from 'better-sqlite3';
import { createLogger, coerceArray } from '@media-router/shared-types';

const log = createLogger('ConfigStore');

/**
 * Coerce a loaded profile config into a well-formed shape so callers never see
 * `interlocks: undefined` or (from an earlier applyJsonPatch bug) `interlocks: { "-": {...} }`.
 * This is the single coercion point — PatchRouter / SocketIOSetup / reconcileInterlocks
 * no longer need defensive `Array.isArray` checks.
 */
function normalizeProfileConfig(config: Record<string, unknown>): Record<string, unknown> {
    config.interlocks = coerceArray(config.interlocks);
    config.connections = coerceArray(config.connections);
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
        this.migrateSchema();
        this.ensureDefaultGroup();
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
                group_id TEXT NOT NULL DEFAULT 'ungrouped',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS engine_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                collapsed INTEGER NOT NULL DEFAULT 0,
                is_default INTEGER NOT NULL DEFAULT 0,
                color TEXT,
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

    /**
     * Add columns introduced after the initial schema. SQLite's `ADD COLUMN`
     * is idempotent only with a guard, so we check `PRAGMA table_info` first.
     * Existing rows pick up the column default.
     */
    private migrateSchema(): void {
        const engineCols = this.db.prepare("PRAGMA table_info('engines')").all() as Array<{
            name: string;
        }>;
        const engineNames = new Set(engineCols.map((c) => c.name));
        if (!engineNames.has('group_id')) {
            this.db.exec(
                "ALTER TABLE engines ADD COLUMN group_id TEXT NOT NULL DEFAULT 'ungrouped'",
            );
        }
        if (!engineNames.has('sort_order')) {
            this.db.exec('ALTER TABLE engines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
            // Preserve historic order: assign sort_order by created_at.
            const rows = this.db
                .prepare(
                    'SELECT engine_id FROM engines ORDER BY created_at ASC, engine_id ASC',
                )
                .all() as Array<{ engine_id: string }>;
            const upd = this.db.prepare(
                'UPDATE engines SET sort_order = ? WHERE engine_id = ?',
            );
            rows.forEach((r, i) => upd.run(i, r.engine_id));
        }

        const groupCols = this.db.prepare("PRAGMA table_info('engine_groups')").all() as Array<{
            name: string;
        }>;
        const groupNames = new Set(groupCols.map((c) => c.name));
        if (!groupNames.has('color')) {
            this.db.exec('ALTER TABLE engine_groups ADD COLUMN color TEXT');
        }
    }

    /**
     * Every engine has a group. The "Ungrouped" row is a real group flagged
     * `is_default=1` — it can be renamed/collapsed but not deleted, and is the
     * fallback when a custom group is removed.
     */
    private ensureDefaultGroup(): void {
        const row = this.db
            .prepare("SELECT id FROM engine_groups WHERE id = 'ungrouped'")
            .get();
        if (!row) {
            this.db
                .prepare(
                    "INSERT INTO engine_groups (id, name, sort_order, collapsed, is_default) VALUES ('ungrouped', 'Ungrouped', 0, 0, 1)",
                )
                .run();
        }
    }

    /**
     * Seed the database with a demo engine + Audio Input → Audio Output
     * profile on first start so the operator gets a working "hello world"
     * routing without configuring anything.
     *
     * NOTE: this is a demo seed, not core architecture. It hard-codes the
     * `audio-input` / `audio-output` pluginIds; if those plugins are removed
     * or renamed the seeded profile will reference plugins that don't load.
     * Set `MR_SKIP_SEED=1` to disable seeding entirely (production deployments
     * that ship a profile in the image, integration tests that need a clean
     * DB, etc.). Skipped automatically for in-memory DBs.
     */
    private seedDefaults(): void {
        if (this.db.name === ':memory:' || this.db.name === '') return; // Skip for tests
        if (process.env.MR_SKIP_SEED === '1' || process.env.MR_SKIP_SEED === 'true') {
            log.info('MR_SKIP_SEED set — skipping default engine/profile seed');
            return;
        }
        const count = (this.db.prepare('SELECT COUNT(*) as c FROM engines').get() as { c: number })
            .c;
        if (count > 0) return; // Already has data

        log.info('First start — seeding demo engine and profile');

        const engineId = 'local';
        const password = 'media-router';

        // Create default engine
        this.db
            .prepare(
                'INSERT INTO engines (engine_id, display_name, password, active_profile) VALUES (?, ?, ?, ?)',
            )
            .run(engineId, 'Local Engine', password, 'default');

        // Create demo profile with Audio Input → Audio Output
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

    getEngine(engineId: string): Record<string, unknown> | undefined {
        return this.db.prepare('SELECT * FROM engines WHERE engine_id = ?').get(engineId) as
            | Record<string, unknown>
            | undefined;
    }

    getAllEngines(): Array<Record<string, unknown>> {
        return this.db
            .prepare('SELECT * FROM engines ORDER BY sort_order ASC, engine_id ASC')
            .all() as Array<Record<string, unknown>>;
    }

    // --- Engine Groups ---

    getAllGroups(): Array<Record<string, unknown>> {
        return this.db
            .prepare('SELECT * FROM engine_groups ORDER BY sort_order ASC, id ASC')
            .all() as Array<Record<string, unknown>>;
    }

    getGroup(groupId: string): Record<string, unknown> | undefined {
        return this.db.prepare('SELECT * FROM engine_groups WHERE id = ?').get(groupId) as
            | Record<string, unknown>
            | undefined;
    }

    createGroup(groupId: string, name: string, color?: string | null): void {
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

    updateGroup(
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
    deleteGroup(groupId: string): void {
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
    reorderGroups(orderedIds: string[]): void {
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

    /**
     * Bulk-assign engines to groups + positions. The full updates array is
     * applied in one transaction so a partial failure doesn't leave the list
     * half-reordered.
     */
    reorderEngines(
        updates: Array<{ engineId: string; groupId: string; sortOrder: number }>,
    ): void {
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

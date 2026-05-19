import type Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('ConfigSchema');

/**
 * Apply the full SQLite schema to a database.
 *
 * Idempotent: safe to call on every startup. Runs the DDL, applies additive
 * column migrations for columns added after the initial schema, ensures the
 * default `ungrouped` engine-group row exists, and (unless suppressed) seeds
 * a demo audio-input → audio-output profile so the first-start operator sees
 * a working routing.
 *
 * Seeding is automatically skipped for in-memory or unnamed databases (test
 * fixtures), and can be disabled in production via `MR_SKIP_SEED=1`.
 */
export function applySchema(db: Database.Database): void {
    createTables(db);
    migrateSchema(db);
    ensureDefaultGroup(db);
    if (shouldSeed(db)) {
        seedDefaults(db);
    }
}

function shouldSeed(db: Database.Database): boolean {
    if (db.name === ':memory:' || db.name === '') return false; // tests
    if (process.env.MR_SKIP_SEED === '1' || process.env.MR_SKIP_SEED === 'true') {
        log.info('MR_SKIP_SEED set — skipping default engine/profile seed');
        return false;
    }
    return true;
}

function createTables(db: Database.Database): void {
    db.exec(`
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
function migrateSchema(db: Database.Database): void {
    const engineCols = db.prepare("PRAGMA table_info('engines')").all() as Array<{
        name: string;
    }>;
    const engineNames = new Set(engineCols.map((c) => c.name));
    if (!engineNames.has('group_id')) {
        db.exec("ALTER TABLE engines ADD COLUMN group_id TEXT NOT NULL DEFAULT 'ungrouped'");
    }
    if (!engineNames.has('sort_order')) {
        db.exec('ALTER TABLE engines ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
        // Preserve historic order: assign sort_order by created_at.
        const rows = db
            .prepare('SELECT engine_id FROM engines ORDER BY created_at ASC, engine_id ASC')
            .all() as Array<{ engine_id: string }>;
        const upd = db.prepare('UPDATE engines SET sort_order = ? WHERE engine_id = ?');
        rows.forEach((r, i) => upd.run(i, r.engine_id));
    }

    const groupCols = db.prepare("PRAGMA table_info('engine_groups')").all() as Array<{
        name: string;
    }>;
    const groupNames = new Set(groupCols.map((c) => c.name));
    if (!groupNames.has('color')) {
        db.exec('ALTER TABLE engine_groups ADD COLUMN color TEXT');
    }
}

/**
 * Every engine has a group. The "Ungrouped" row is a real group flagged
 * `is_default=1` — it can be renamed/collapsed but not deleted, and is the
 * fallback when a custom group is removed.
 */
function ensureDefaultGroup(db: Database.Database): void {
    const row = db.prepare("SELECT id FROM engine_groups WHERE id = 'ungrouped'").get();
    if (!row) {
        db.prepare(
            "INSERT INTO engine_groups (id, name, sort_order, collapsed, is_default) VALUES ('ungrouped', 'Ungrouped', 0, 0, 1)",
        ).run();
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
function seedDefaults(db: Database.Database): void {
    const count = (db.prepare('SELECT COUNT(*) as c FROM engines').get() as { c: number }).c;
    if (count > 0) return; // Already has data

    log.info('First start — seeding demo engine and profile');

    const engineId = 'local';
    const password = 'media-router';

    db.prepare(
        'INSERT INTO engines (engine_id, display_name, password, active_profile) VALUES (?, ?, ?, ?)',
    ).run(engineId, 'Local Engine', password, 'default');

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

    db.prepare(
        'INSERT INTO engine_profiles (engine_id, profile_name, config) VALUES (?, ?, ?)',
    ).run(engineId, 'default', JSON.stringify(config));
}

import Database from 'better-sqlite3';
import { createLogger } from '@media-router/shared-types';
import { applySchema } from './ConfigSchema.js';
import { EngineRepository } from './EngineRepository.js';
import { EngineGroupRepository } from './EngineGroupRepository.js';
import { ProfileRepository } from './ProfileRepository.js';
import { ConfigHistoryRepository } from './ConfigHistoryRepository.js';

const log = createLogger('ConfigStore');

/**
 * SQLite configuration store for the Manager.
 *
 * Thin facade over four per-table repositories:
 *   - `EngineRepository` — `engines`
 *   - `EngineGroupRepository` — `engine_groups`
 *   - `ProfileRepository` — `engine_profiles`
 *   - `ConfigHistoryRepository` — `engine_config_history` + debounce timers
 *
 * The facade orchestrates cross-table cascades (e.g. `deleteEngine` removes
 * profiles + history) so each repo stays single-table. Schema setup (DDL,
 * migrations, default group, demo seed) lives in `ConfigSchema.ts`.
 */
export class ConfigStore {
    private db: Database.Database;
    private engines: EngineRepository;
    private groups: EngineGroupRepository;
    private profiles: ProfileRepository;
    private history: ConfigHistoryRepository;

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
        applySchema(this.db);

        this.history = new ConfigHistoryRepository(this.db);
        this.engines = new EngineRepository(this.db);
        this.groups = new EngineGroupRepository(this.db);
        this.profiles = new ProfileRepository(this.db, this.history);

        log.info({ dbPath }, 'database opened');
    }

    // --- Engine CRUD ---

    createEngine(engineId: string, displayName: string, password: string): void {
        this.engines.create(engineId, displayName, password);
    }

    getEngine(engineId: string): Record<string, unknown> | undefined {
        return this.engines.get(engineId);
    }

    getAllEngines(): Array<Record<string, unknown>> {
        return this.engines.getAll();
    }

    updateEngine(engineId: string, displayName: string, password?: string): void {
        this.engines.update(engineId, displayName, password);
    }

    /**
     * Rename an engine's primary key, optionally applying a display_name +
     * password change in the same transaction. Caller must verify `newId` is
     * free — we re-check here defensively so callers can't race themselves,
     * and the underlying transaction would throw on the PK collision anyway.
     *
     * NOTE: this changes the identity the engine authenticates with. The
     * engine itself reads its identity from `profile.name` in its local
     * `profiles.json` — until that's updated to match, the engine will
     * reconnect under the old name and auth will fail. The HTTP layer
     * exposes this to the operator as a warning.
     */
    renameEngine(
        oldId: string,
        newId: string,
        meta?: { displayName?: string; password?: string },
    ): void {
        if (oldId !== newId && this.engines.get(newId)) {
            throw new Error(`Engine ID already exists: ${newId}`);
        }
        // Same-id case flows through the same code path — the PK update is a
        // no-op, the FK cascades are no-ops, and any meta fields apply.
        // Avoids a separate shortcut that historically silently dropped
        // password-only updates.
        this.engines.rename(oldId, newId, meta);
    }

    /** Cascades through `engine_profiles` and `engine_config_history`. */
    deleteEngine(engineId: string): void {
        try {
            this.profiles.deleteByEngine(engineId);
            this.history.deleteByEngine(engineId);
            this.engines.delete(engineId);
        } catch (err) {
            log.error({ err, engineId }, 'Failed to delete engine');
            throw err;
        }
    }

    reorderEngines(
        updates: Array<{ engineId: string; groupId: string; sortOrder: number }>,
    ): void {
        this.engines.reorder(updates);
    }

    // --- Engine Groups ---

    getAllGroups(): Array<Record<string, unknown>> {
        return this.groups.getAll();
    }

    getGroup(groupId: string): Record<string, unknown> | undefined {
        return this.groups.get(groupId);
    }

    createGroup(groupId: string, name: string, color?: string | null): void {
        this.groups.create(groupId, name, color);
    }

    updateGroup(
        groupId: string,
        fields: { name?: string; collapsed?: boolean; color?: string | null },
    ): void {
        this.groups.update(groupId, fields);
    }

    deleteGroup(groupId: string): void {
        this.groups.delete(groupId);
    }

    reorderGroups(orderedIds: string[]): void {
        this.groups.reorder(orderedIds);
    }

    // --- Profile CRUD ---

    createProfile(
        engineId: string,
        profileName: string,
        config: Record<string, unknown> = {},
    ): void {
        this.profiles.create(engineId, profileName, config);
    }

    getProfile(engineId: string, profileName: string): Record<string, unknown> | undefined {
        return this.profiles.get(engineId, profileName);
    }

    getProfiles(engineId: string): Array<{ profile_name: string }> {
        return this.profiles.list(engineId);
    }

    setActiveProfile(engineId: string, profileName: string): void {
        this.engines.setActiveProfile(engineId, profileName);
    }

    updateProfileConfig(
        engineId: string,
        profileName: string,
        config: Record<string, unknown>,
    ): void {
        this.profiles.update(engineId, profileName, config);
    }

    modifyProfileConfig(
        engineId: string,
        profileName: string,
        modifier: (config: Record<string, unknown>) => Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        return this.profiles.modify(engineId, profileName, modifier);
    }

    deleteProfile(engineId: string, profileName: string): void {
        this.profiles.delete(engineId, profileName);
    }

    // --- Version History ---

    getVersionHistory(
        engineId: string,
        profileName: string,
    ): Array<{ id: number; saved_at: string; config: string }> {
        return this.history.list(engineId, profileName);
    }

    getVersion(
        engineId: string,
        profileName: string,
        versionId: number,
    ): Record<string, unknown> | undefined {
        return this.history.getVersion(engineId, profileName, versionId);
    }

    // --- Lifecycle ---

    close(): void {
        this.history.clear();
        this.db.close();
    }
}

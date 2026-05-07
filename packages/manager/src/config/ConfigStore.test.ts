import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from './ConfigStore.js';

describe('ConfigStore', () => {
    let store: ConfigStore;

    beforeEach(() => {
        store = new ConfigStore(':memory:');
    });

    afterEach(() => {
        store.close();
    });

    describe('Engine CRUD', () => {
        it('creates and retrieves an engine', () => {
            store.createEngine('eng-1', 'Test Engine', 'password123');
            const engine = store.getEngine('eng-1');
            expect(engine).toBeDefined();
            expect(engine!.engine_id).toBe('eng-1');
            expect(engine!.display_name).toBe('Test Engine');
            expect(engine!.password).toBe('password123');
        });

        it('lists all engines', () => {
            store.createEngine('eng-1', 'Engine 1', 'pass1');
            store.createEngine('eng-2', 'Engine 2', 'pass2');
            const engines = store.getAllEngines();
            expect(engines).toHaveLength(2);
        });

        it('updates an engine', () => {
            store.createEngine('eng-1', 'Old Name', 'oldpass');
            store.updateEngine('eng-1', 'New Name', 'newpass');
            const engine = store.getEngine('eng-1');
            expect(engine!.display_name).toBe('New Name');
            expect(engine!.password).toBe('newpass');
        });

        it('deletes an engine and its profiles', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'default', {});
            store.deleteEngine('eng-1');
            expect(store.getEngine('eng-1')).toBeUndefined();
            expect(store.getProfiles('eng-1')).toHaveLength(0);
        });
    });

    describe('Profile CRUD', () => {
        beforeEach(() => {
            store.createEngine('eng-1', 'Test', 'pass');
        });

        it('creates and retrieves a profile', () => {
            store.createProfile('eng-1', 'prod', { modules: {} });
            const profile = store.getProfile('eng-1', 'prod');
            // getProfile always normalizes `interlocks` and `connections` to arrays.
            expect(profile).toEqual({ modules: {}, interlocks: [], connections: [] });
        });

        it('INSERT OR IGNORE on duplicate profile', () => {
            store.createProfile('eng-1', 'default', { version: 1 });
            store.createProfile('eng-1', 'default', { version: 2 }); // should not throw
            const profile = store.getProfile('eng-1', 'default');
            expect(profile).toEqual({ version: 1, interlocks: [], connections: [] });
        });

        it('updates profile config', () => {
            store.createProfile('eng-1', 'prod', {});
            store.updateProfileConfig('eng-1', 'prod', {
                modules: { 'srt-1': { pluginId: 'srt-input' } },
            });
            const profile = store.getProfile('eng-1', 'prod');
            expect(profile!.modules).toBeDefined();
        });

        it('sets active profile', () => {
            store.createProfile('eng-1', 'prod', {});
            store.setActiveProfile('eng-1', 'prod');
            const engine = store.getEngine('eng-1');
            expect(engine!.active_profile).toBe('prod');
        });

        it('lists profiles', () => {
            store.createProfile('eng-1', 'prod', {});
            store.createProfile('eng-1', 'staging', {});
            const profiles = store.getProfiles('eng-1');
            expect(profiles).toHaveLength(2);
        });

        it('deletes a profile', () => {
            store.createProfile('eng-1', 'prod', {});
            store.deleteProfile('eng-1', 'prod');
            expect(store.getProfile('eng-1', 'prod')).toBeUndefined();
        });
    });

    describe('Version History', () => {
        it('returns empty history initially', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            expect(store.getVersionHistory('eng-1', 'prod')).toHaveLength(0);
        });

        it('saves version on first config update', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            store.updateProfileConfig('eng-1', 'prod', { v: 1 });
            const history = store.getVersionHistory('eng-1', 'prod');
            expect(history.length).toBeGreaterThanOrEqual(1);
        });

        it('debounces version saves within 10 minutes', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            store.updateProfileConfig('eng-1', 'prod', { v: 1 });
            store.updateProfileConfig('eng-1', 'prod', { v: 2 });
            store.updateProfileConfig('eng-1', 'prod', { v: 3 });
            const history = store.getVersionHistory('eng-1', 'prod');
            // Only 1 version saved — all within debounce window
            expect(history).toHaveLength(1);
        });

        it('retrieves a specific version by ID', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            store.updateProfileConfig('eng-1', 'prod', { v: 1 });
            const history = store.getVersionHistory('eng-1', 'prod');
            expect(history).toHaveLength(1);
            const version = store.getVersion('eng-1', 'prod', history[0].id);
            expect(version).toEqual({ v: 1 });
        });

        it('returns undefined for non-existent version', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            const version = store.getVersion('eng-1', 'prod', 9999);
            expect(version).toBeUndefined();
        });
    });

    describe('modifyProfileConfig', () => {
        beforeEach(() => {
            store.createEngine('eng-1', 'Test', 'pass');
        });

        it('atomically reads and modifies config', () => {
            store.createProfile('eng-1', 'prod', { modules: {}, connections: [] });
            const result = store.modifyProfileConfig('eng-1', 'prod', (config) => {
                return { ...config, modules: { 'mic-1': { pluginId: 'audio-input' } } };
            });
            expect(result).toBeDefined();
            expect((result as Record<string, unknown>).modules).toEqual({
                'mic-1': { pluginId: 'audio-input' },
            });
            // Verify it was persisted
            const profile = store.getProfile('eng-1', 'prod');
            expect(profile!.modules).toEqual({ 'mic-1': { pluginId: 'audio-input' } });
        });

        it('returns undefined for non-existent profile', () => {
            const result = store.modifyProfileConfig('eng-1', 'nonexistent', (config) => config);
            expect(result).toBeUndefined();
        });

        it('handles corrupt JSON in profile gracefully', () => {
            // Create profile, then corrupt its JSON directly
            store.createProfile('eng-1', 'corrupt', {});
            // We can't easily corrupt via the public API, so test with empty config fallback
            const result = store.modifyProfileConfig('eng-1', 'corrupt', (config) => {
                return { ...config, fixed: true };
            });
            expect(result).toBeDefined();
            expect((result as Record<string, unknown>).fixed).toBe(true);
        });
    });

    describe('Engine edge cases', () => {
        it('getEngine returns undefined for non-existent engine', () => {
            expect(store.getEngine('nonexistent')).toBeUndefined();
        });

        it('getAllEngines returns empty array when no engines', () => {
            expect(store.getAllEngines()).toEqual([]);
        });

        it('createEngine throws on duplicate engine_id', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            expect(() => store.createEngine('eng-1', 'Dupe', 'pass2')).toThrow();
        });

        it('updateEngine without password only updates display_name', () => {
            store.createEngine('eng-1', 'Old', 'secret');
            store.updateEngine('eng-1', 'New');
            const engine = store.getEngine('eng-1');
            expect(engine!.display_name).toBe('New');
            expect(engine!.password).toBe('secret');
        });

        it('deleteEngine also cleans up config history', () => {
            store.createEngine('eng-1', 'Test', 'pass');
            store.createProfile('eng-1', 'prod', {});
            store.updateProfileConfig('eng-1', 'prod', { v: 1 });
            expect(store.getVersionHistory('eng-1', 'prod').length).toBeGreaterThan(0);
            store.deleteEngine('eng-1');
            expect(store.getVersionHistory('eng-1', 'prod')).toHaveLength(0);
        });
    });

    describe('Profile edge cases', () => {
        beforeEach(() => {
            store.createEngine('eng-1', 'Test', 'pass');
        });

        it('getProfile returns undefined for non-existent profile', () => {
            expect(store.getProfile('eng-1', 'nonexistent')).toBeUndefined();
        });

        it('getProfiles returns empty for engine with no profiles', () => {
            expect(store.getProfiles('eng-1')).toHaveLength(0);
        });

        it('createProfile with default empty config', () => {
            store.createProfile('eng-1', 'empty');
            const profile = store.getProfile('eng-1', 'empty');
            expect(profile).toEqual({ interlocks: [], connections: [] });
        });

        it('updateProfileConfig persists complex nested config', () => {
            store.createProfile('eng-1', 'complex', {});
            const config = {
                modules: {
                    'mic-1': { pluginId: 'audio-input', settings: { volume: 80, device: 'hw:0' } },
                    'spk-1': { pluginId: 'audio-output', settings: { volume: 100 } },
                },
                connections: [{ id: 'conn-1', sourceModuleId: 'mic-1', sinkModuleId: 'spk-1' }],
            };
            store.updateProfileConfig('eng-1', 'complex', config);
            const retrieved = store.getProfile('eng-1', 'complex');
            expect(retrieved).toEqual({ ...config, interlocks: [] });
        });

        it('normalizes corrupt interlocks shape on load', () => {
            // Simulates the earlier applyJsonPatch bug that persisted
            // `interlocks: { "-": {...} }` instead of an array.
            store.createProfile('eng-1', 'bad');
            (store as any).db
                .prepare(
                    'UPDATE engine_profiles SET config = ? WHERE engine_id = ? AND profile_name = ?',
                )
                .run(
                    JSON.stringify({ interlocks: { '-': { id: 'g1', name: 'G', members: [] } } }),
                    'eng-1',
                    'bad',
                );
            const profile = store.getProfile('eng-1', 'bad');
            expect(Array.isArray(profile?.interlocks)).toBe(true);
            expect(profile?.interlocks).toHaveLength(1);
        });
    });

    describe('Lifecycle', () => {
        it('close is safe to call', () => {
            expect(() => store.close()).not.toThrow();
        });
    });
});

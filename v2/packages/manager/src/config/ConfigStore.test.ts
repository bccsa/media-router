import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from './ConfigStore.js';

describe('ConfigStore', () => {
    let store: ConfigStore;

    beforeEach(() => {
        store = new ConfigStore(); // in-memory SQLite
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
            expect(profile).toEqual({ modules: {} });
        });

        it('INSERT OR IGNORE on duplicate profile', () => {
            store.createProfile('eng-1', 'default', { version: 1 });
            store.createProfile('eng-1', 'default', { version: 2 }); // should not throw
            const profile = store.getProfile('eng-1', 'default');
            expect(profile).toEqual({ version: 1 }); // original preserved
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
    });
});

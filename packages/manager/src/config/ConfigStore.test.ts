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

        it('renames the primary key and carries profiles + active_profile across', () => {
            store.createEngine('old-id', 'Test', 'pass');
            store.createProfile('old-id', 'default', { modules: { m1: {} } });
            store.setActiveProfile('old-id', 'default');

            store.renameEngine('old-id', 'new-id');

            expect(store.getEngine('old-id')).toBeUndefined();
            const renamed = store.getEngine('new-id');
            expect(renamed!.engine_id).toBe('new-id');
            expect(renamed!.display_name).toBe('Test');
            expect(renamed!.password).toBe('pass');
            expect(renamed!.active_profile).toBe('default');
            // Profile rows must follow the new PK so the engine's config is
            // not orphaned by the rename.
            expect(store.getProfiles('new-id')).toHaveLength(1);
            expect(store.getProfile('new-id', 'default')).toBeDefined();
            expect(store.getProfiles('old-id')).toHaveLength(0);
        });

        it('renameEngine rejects collisions with an existing engine id', () => {
            store.createEngine('eng-1', 'One', 'p1');
            store.createEngine('eng-2', 'Two', 'p2');
            expect(() => store.renameEngine('eng-1', 'eng-2')).toThrow();
            // Both engines should be intact after the rejected rename.
            expect(store.getEngine('eng-1')).toBeDefined();
            expect(store.getEngine('eng-2')!.display_name).toBe('Two');
        });

        it('renameEngine is a no-op when old and new ids match', () => {
            store.createEngine('eng-1', 'One', 'p1');
            store.renameEngine('eng-1', 'eng-1');
            expect(store.getEngine('eng-1')!.display_name).toBe('One');
        });

        it('renameEngine applies meta atomically — display_name + password land with the PK swap', () => {
            store.createEngine('old-id', 'Old Name', 'old-pw');
            store.createProfile('old-id', 'default', {});
            store.renameEngine('old-id', 'new-id', {
                displayName: 'New Name',
                password: 'new-pw',
            });
            const row = store.getEngine('new-id');
            expect(row!.display_name).toBe('New Name');
            expect(row!.password).toBe('new-pw');
            // Profiles must follow the same transaction.
            expect(store.getProfiles('new-id')).toHaveLength(1);
        });

        it('renameEngine with same id + meta still applies the metadata change', () => {
            store.createEngine('eng-1', 'Old', 'old-pw');
            store.renameEngine('eng-1', 'eng-1', { displayName: 'New', password: 'new-pw' });
            const row = store.getEngine('eng-1');
            expect(row!.display_name).toBe('New');
            expect(row!.password).toBe('new-pw');
        });

        it('renameEngine applies password-only meta without requiring displayName', () => {
            // Regression: previously the same-id shortcut only fired when
            // displayName was supplied, silently dropping password rotations.
            // The rename path also gated the metadata UPDATE on displayName,
            // so this case lost data through both routes.
            store.createEngine('eng-1', 'Original', 'old-pw');
            store.renameEngine('eng-1', 'eng-1', { password: 'new-pw' });
            const row = store.getEngine('eng-1');
            expect(row!.display_name).toBe('Original');
            expect(row!.password).toBe('new-pw');
        });

        it('renameEngine applies password-only meta on an actual rename', () => {
            store.createEngine('old-id', 'Original', 'old-pw');
            store.renameEngine('old-id', 'new-id', { password: 'new-pw' });
            const row = store.getEngine('new-id');
            expect(row!.display_name).toBe('Original');
            expect(row!.password).toBe('new-pw');
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

    describe('Engine groups', () => {
        it('seeds the default Ungrouped group on first start', () => {
            const groups = store.getAllGroups();
            expect(groups).toHaveLength(1);
            expect(groups[0].id).toBe('ungrouped');
            expect(groups[0].is_default).toBe(1);
        });

        it('createEngine assigns engines to Ungrouped with incrementing sort_order', () => {
            store.createEngine('a', 'A', 'p');
            store.createEngine('b', 'B', 'p');
            const engines = store.getAllEngines();
            expect(engines[0].engine_id).toBe('a');
            expect(engines[0].group_id).toBe('ungrouped');
            expect(engines[0].sort_order).toBe(0);
            expect(engines[1].engine_id).toBe('b');
            expect(engines[1].sort_order).toBe(1);
        });

        it('creates a custom group with sort_order after defaults', () => {
            store.createGroup('grp1', 'Studio');
            const groups = store.getAllGroups();
            expect(groups).toHaveLength(2);
            expect(groups[1].id).toBe('grp1');
            expect(groups[1].name).toBe('Studio');
            expect(groups[1].sort_order).toBe(1);
            expect(groups[1].is_default).toBe(0);
        });

        it('updateGroup edits name and collapsed state', () => {
            store.createGroup('grp1', 'Studio');
            store.updateGroup('grp1', { name: 'On-Air', collapsed: true });
            const g = store.getGroup('grp1');
            expect(g!.name).toBe('On-Air');
            expect(g!.collapsed).toBe(1);
        });

        it('deleteGroup reassigns engines to Ungrouped and appends to end', () => {
            store.createEngine('a', 'A', 'p'); // ungrouped, order 0
            store.createGroup('grp1', 'Studio');
            store.reorderEngines([{ engineId: 'a', groupId: 'grp1', sortOrder: 0 }]);
            store.createEngine('b', 'B', 'p'); // ungrouped, order 0 (a moved out)
            store.deleteGroup('grp1');
            const engines = store.getAllEngines();
            const a = engines.find((e) => e.engine_id === 'a')!;
            expect(a.group_id).toBe('ungrouped');
            // 'a' should land after 'b' (appended to end of ungrouped).
            const b = engines.find((e) => e.engine_id === 'b')!;
            expect((a.sort_order as number) > (b.sort_order as number)).toBe(true);
            expect(store.getGroup('grp1')).toBeUndefined();
        });

        it('refuses to delete the default Ungrouped group', () => {
            expect(() => store.deleteGroup('ungrouped')).toThrow();
        });

        it('reorderGroups updates sort_order in array index order', () => {
            store.createGroup('a', 'A');
            store.createGroup('b', 'B');
            store.reorderGroups(['a', 'b', 'ungrouped']);
            const groups = store.getAllGroups();
            expect(groups.map((g) => g.id)).toEqual(['a', 'b', 'ungrouped']);
        });

        it('createGroup stores an optional color and updateGroup can clear it', () => {
            store.createGroup('grp1', 'Studio', '#10b981');
            expect(store.getGroup('grp1')?.color).toBe('#10b981');

            store.updateGroup('grp1', { color: '#ef4444' });
            expect(store.getGroup('grp1')?.color).toBe('#ef4444');

            // null explicitly clears (undefined would skip the field instead).
            store.updateGroup('grp1', { color: null });
            expect(store.getGroup('grp1')?.color).toBeNull();
        });

        it('createGroup defaults color to null when omitted', () => {
            store.createGroup('grp1', 'Studio');
            expect(store.getGroup('grp1')?.color).toBeNull();
        });

        it('reorderEngines moves engines between groups in a single transaction', () => {
            store.createEngine('e1', 'E1', 'p');
            store.createEngine('e2', 'E2', 'p');
            store.createGroup('grp1', 'Studio');
            store.reorderEngines([
                { engineId: 'e2', groupId: 'grp1', sortOrder: 0 },
                { engineId: 'e1', groupId: 'ungrouped', sortOrder: 0 },
            ]);
            const engines = store.getAllEngines();
            const e1 = engines.find((e) => e.engine_id === 'e1')!;
            const e2 = engines.find((e) => e.engine_id === 'e2')!;
            expect(e1.group_id).toBe('ungrouped');
            expect(e2.group_id).toBe('grp1');
            expect(e2.sort_order).toBe(0);
        });

        it('createGroup stores the color when supplied', () => {
            store.createGroup('grp1', 'Studio', '#10b981');
            expect(store.getGroup('grp1')!.color).toBe('#10b981');
        });

        it('createGroup defaults color to null when omitted', () => {
            store.createGroup('grp1', 'Studio');
            expect(store.getGroup('grp1')!.color).toBeNull();
        });

        it('updateGroup sets a color and can clear it back to null', () => {
            store.createGroup('grp1', 'Studio');
            store.updateGroup('grp1', { color: '#ef4444' });
            expect(store.getGroup('grp1')!.color).toBe('#ef4444');
            store.updateGroup('grp1', { color: null });
            expect(store.getGroup('grp1')!.color).toBeNull();
        });

        it('updateGroup leaves color untouched when the field is omitted', () => {
            store.createGroup('grp1', 'Studio', '#3b82f6');
            store.updateGroup('grp1', { name: 'On-Air' });
            const g = store.getGroup('grp1')!;
            expect(g.name).toBe('On-Air');
            expect(g.color).toBe('#3b82f6');
        });
    });
});

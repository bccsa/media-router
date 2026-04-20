import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useModuleStore } from './modules';

describe('LCP Module Store', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it('setAll populates modules', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpVisible: true },
                lcpType: 'mixer-strip',
            },
            'enc-1': {
                pluginId: 'audio-encoder',
                displayName: 'Encoder 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
        });
        expect(Object.keys(store.modules)).toHaveLength(2);
    });

    it('visibleModules filters by lcpVisible and lcpType', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpVisible: true },
                lcpType: 'mixer-strip',
            },
            'srt-1': {
                pluginId: 'srt-input',
                displayName: 'SRT In',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
            }, // no lcpType
            'enc-1': {
                pluginId: 'audio-encoder',
                displayName: 'Encoder',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpVisible: false },
                lcpType: 'mixer-strip',
            },
        });
        expect(store.visibleModules).toHaveLength(1);
        expect(store.visibleModules[0].instanceId).toBe('mic-1');
    });

    it('visibleModules sorts by lcpSortOrder', () => {
        const store = useModuleStore();
        store.setAll({
            'out-1': {
                pluginId: 'audio-output',
                displayName: 'Output',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpSortOrder: 10 },
                lcpType: 'mixer-strip',
            },
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpSortOrder: 1 },
                lcpType: 'mixer-strip',
            },
            'enc-1': {
                pluginId: 'audio-encoder',
                displayName: 'Encoder',
                health: 'ok',
                running: true,
                ready: true,
                settings: { lcpSortOrder: 5 },
                lcpType: 'mixer-strip',
            },
        });
        const names = store.visibleModules.map((m) => m.displayName);
        expect(names).toEqual(['Mic', 'Encoder', 'Output']);
    });

    it('updateState merges with existing module', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'stopped',
                running: false,
                ready: false,
                settings: { lcpVisible: true },
                lcpType: 'mixer-strip',
            },
        });
        store.updateState('mic-1', { health: 'ok', running: true, ready: true });
        expect(store.modules['mic-1'].health).toBe('ok');
        expect(store.modules['mic-1'].displayName).toBe('Mic 1'); // preserved
    });

    it('applyConfig updates settings', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { volume: 100 },
                lcpType: 'mixer-strip',
            },
        });
        store.applyConfig({
            'mic-1': { displayName: 'Mic 1', settings: { volume: 75 }, lcpType: 'mixer-strip' },
        });
        expect(store.modules['mic-1'].settings.volume).toBe(75);
    });

    it('applyConfig removes deleted modules', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
            'mic-2': {
                pluginId: 'audio-input',
                displayName: 'Mic 2',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
        });
        store.applyConfig({
            'mic-1': { displayName: 'Mic 1', settings: {}, lcpType: 'mixer-strip' },
        });
        expect(Object.keys(store.modules)).toHaveLength(1);
        expect(store.modules['mic-2']).toBeUndefined();
    });

    it('remove deletes a module', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
        });
        store.remove('mic-1');
        expect(Object.keys(store.modules)).toHaveLength(0);
    });

    it('default lcpVisible is true (modules visible by default)', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
        });
        // No explicit lcpVisible — should default to visible
        expect(store.visibleModules).toHaveLength(1);
    });

    // --- applyPatch (live config sync) ---

    it('applyPatch updates a single setting', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { volume: 100, audioEnabled: true },
                lcpType: 'mixer-strip',
            },
        });
        store.applyPatch([
            { op: 'replace', path: '/modules/mic-1/settings/audioEnabled', value: false },
        ]);
        expect(store.modules['mic-1'].settings?.audioEnabled).toBe(false);
        expect(store.modules['mic-1'].settings?.volume).toBe(100); // unchanged
    });

    it('applyPatch handles multiple changes', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { volume: 100, audioEnabled: true },
                lcpType: 'mixer-strip',
            },
        });
        store.applyPatch([
            { op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 },
            { op: 'replace', path: '/modules/mic-1/settings/audioEnabled', value: false },
        ]);
        expect(store.modules['mic-1'].settings?.volume).toBe(75);
        expect(store.modules['mic-1'].settings?.audioEnabled).toBe(false);
    });

    it('applyPatch with full config replace (path=/)', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: {},
                lcpType: 'mixer-strip',
            },
        });
        store.applyPatch([
            {
                op: 'replace',
                path: '/',
                value: {
                    modules: {
                        'new-1': {
                            pluginId: 'audio-output',
                            displayName: 'New 1',
                            settings: { volume: 50 },
                            lcpType: 'mixer-strip',
                        },
                    },
                },
            },
        ]);
        expect(store.modules['mic-1']).toBeUndefined();
        expect(store.modules['new-1']?.displayName).toBe('New 1');
    });

    it('applyPatch ignores unknown paths gracefully', () => {
        const store = useModuleStore();
        store.setAll({
            'mic-1': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                health: 'ok',
                running: true,
                ready: true,
                settings: { volume: 100 },
                lcpType: 'mixer-strip',
            },
        });
        store.applyPatch([
            { op: 'replace', path: '/unknown/path', value: 42 },
            { op: 'replace', path: '/modules/nonexistent/settings/volume', value: 50 },
        ]);
        expect(store.modules['mic-1'].settings?.volume).toBe(100);
    });
});

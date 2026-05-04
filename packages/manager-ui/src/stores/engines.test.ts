/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEngineStore } from './engines';

describe('useEngineStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    describe('addEngine', () => {
        it('adds an engine from server data', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'Test Engine',
                online: true,
                running: false,
                active_profile: 'default',
                modules: {},
                connections: [],
            });

            expect(store.engineList).toHaveLength(1);
            expect(store.getEngine('eng-1')).toBeDefined();
            expect(store.getEngine('eng-1')!.name).toBe('Test Engine');
            expect(store.getEngine('eng-1')!.online).toBe(true);
        });

        it('normalises modules with instanceId', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'E1',
                modules: {
                    'audio-input-abc': {
                        pluginId: 'audio-input',
                        displayName: 'Mic 1',
                        running: true,
                        health: 'ok',
                        settings: { device: 'alsa_input.usb-mic' },
                        color: '#3b82f6',
                        icon: 'mic',
                    },
                },
                connections: [],
            });

            const mod = store.getEngine('eng-1')!.modules['audio-input-abc'];
            expect(mod.instanceId).toBe('audio-input-abc');
            expect(mod.pluginId).toBe('audio-input');
            expect(mod.displayName).toBe('Mic 1');
            expect(mod.running).toBe(true);
            expect(mod.health).toBe('ok');
            expect(mod.color).toBe('#3b82f6');
            expect(mod.settings.device).toBe('alsa_input.usb-mic');
        });

        it('handles missing optional fields with defaults', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                modules: {
                    'mod-1': { pluginId: 'test' },
                },
                connections: [],
            });

            const mod = store.getEngine('eng-1')!.modules['mod-1'];
            expect(mod.displayName).toBe('mod-1'); // falls back to ID
            expect(mod.running).toBe(false);
            expect(mod.enabled).toBe(true);
            expect(mod.health).toBe('stopped');
        });
    });

    describe('getEngine', () => {
        it('returns undefined for unknown engine', () => {
            const store = useEngineStore();
            expect(store.getEngine('nonexistent')).toBeUndefined();
        });
    });

    describe('applyEnginePatch', () => {
        beforeEach(() => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'E1',
                online: true,
                modules: {
                    'mod-1': {
                        pluginId: 'audio-input',
                        displayName: 'Mic 1',
                        running: false,
                        health: 'stopped',
                        settings: { device: '' },
                    },
                },
                connections: [],
            });
        });

        it('replaces a top-level field', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [{ op: 'replace', path: '/online', value: false }]);
            expect(store.getEngine('eng-1')!.online).toBe(false);
        });

        it('replaces a module field', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                { op: 'replace', path: '/modules/mod-1/running', value: true },
            ]);
            expect(store.getEngine('eng-1')!.modules['mod-1'].running).toBe(true);
        });

        it('replaces a nested settings field', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/device', value: 'new-mic' },
            ]);
            expect(store.getEngine('eng-1')!.modules['mod-1'].settings.device).toBe('new-mic');
        });

        it('adds a new module', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                {
                    op: 'add',
                    path: '/modules/mod-2',
                    value: {
                        instanceId: 'mod-2',
                        pluginId: 'audio-encoder',
                        displayName: 'Encoder 1',
                        running: false,
                        health: 'stopped',
                        settings: {},
                    },
                },
            ]);
            expect(store.getEngine('eng-1')!.modules['mod-2']).toBeDefined();
            expect(store.getEngine('eng-1')!.modules['mod-2'].displayName).toBe('Encoder 1');
        });

        it('normalises a cloned module so optional fields have defaults', () => {
            // Clone only copies the fields the UI knows about — `pendingRestart`,
            // `focused`, `interlock`, etc. aren't set by the sender. Without
            // normalisation on the optimistic apply the new node renders with
            // `undefined` values until a refresh rehydrates it via engine:config.
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                {
                    op: 'add',
                    path: '/modules/mod-clone',
                    value: {
                        pluginId: 'audio-encoder',
                        displayName: 'Encoder (copy)',
                        settings: { bitrate: 128 },
                    },
                },
            ]);
            const cloned = store.getEngine('eng-1')!.modules['mod-clone'];
            expect(cloned.instanceId).toBe('mod-clone');
            expect(cloned.pendingRestart).toBe(false);
            expect(cloned.focused).toBe(false);
            expect(cloned.interlock).toBe(false);
            expect(cloned.enabled).toBe(true);
            expect(cloned.running).toBe(false);
            expect(cloned.health).toBe('stopped');
            expect(cloned.settings).toEqual({ bitrate: 128 });
        });

        it('removes a module', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [{ op: 'remove', path: '/modules/mod-1' }]);
            expect(store.getEngine('eng-1')!.modules['mod-1']).toBeUndefined();
        });

        it('adds a connection', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                {
                    op: 'add',
                    path: '/connections/-',
                    value: {
                        id: 'mod-1:out-mod-2:in',
                        sourceModuleId: 'mod-1',
                        sourcePortId: 'out',
                        sinkModuleId: 'mod-2',
                        sinkPortId: 'in',
                    },
                },
            ]);
            expect(store.getEngine('eng-1')!.connections).toHaveLength(1);
            expect(store.getEngine('eng-1')!.connections[0].id).toBe('mod-1:out-mod-2:in');
        });

        it('ignores patch for unknown engine', () => {
            const store = useEngineStore();
            store.applyEnginePatch('nonexistent', [
                { op: 'replace', path: '/online', value: false },
            ]);
            // Should not throw
        });

        it('applies multiple operations in one patch', () => {
            const store = useEngineStore();
            store.applyEnginePatch('eng-1', [
                { op: 'replace', path: '/modules/mod-1/running', value: true },
                { op: 'replace', path: '/modules/mod-1/health', value: 'ok' },
                { op: 'replace', path: '/online', value: false },
            ]);
            const engine = store.getEngine('eng-1')!;
            expect(engine.modules['mod-1'].running).toBe(true);
            expect(engine.modules['mod-1'].health).toBe('ok');
            expect(engine.online).toBe(false);
        });
    });

    describe('addEngine — IP, hostname, buildNumber', () => {
        it('stores ip, hostname, and buildNumber from server data', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'Pi5',
                online: true,
                modules: {},
                connections: [],
                ip: '10.9.1.214',
                hostname: 'mrstation',
                buildNumber: 'v2.0.0.42',
            });

            const engine = store.getEngine('eng-1')!;
            expect(engine.ip).toBe('10.9.1.214');
            expect(engine.hostname).toBe('mrstation');
            expect(engine.buildNumber).toBe('v2.0.0.42');
        });

        it('handles missing ip/hostname/buildNumber gracefully', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'Pi5',
                modules: {},
                connections: [],
            });

            const engine = store.getEngine('eng-1')!;
            expect(engine.ip).toBeUndefined();
            expect(engine.hostname).toBeUndefined();
            expect(engine.buildNumber).toBeUndefined();
        });
    });

    describe('setEngineInfo', () => {
        beforeEach(() => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'Pi5',
                online: true,
                modules: {},
                connections: [],
            });
        });

        it('updates ip, hostname, and buildNumber', () => {
            const store = useEngineStore();
            store.setEngineInfo('eng-1', {
                ip: '192.168.1.100',
                hostname: 'pi5',
                buildNumber: 'v2.0.1',
            });

            const engine = store.getEngine('eng-1')!;
            expect(engine.ip).toBe('192.168.1.100');
            expect(engine.hostname).toBe('pi5');
            expect(engine.buildNumber).toBe('v2.0.1');
        });

        it('only updates provided fields', () => {
            const store = useEngineStore();
            store.setEngineInfo('eng-1', { ip: '10.0.0.1' });

            const engine = store.getEngine('eng-1')!;
            expect(engine.ip).toBe('10.0.0.1');
            expect(engine.hostname).toBeUndefined();
        });

        it('ignores unknown engine', () => {
            const store = useEngineStore();
            store.setEngineInfo('nonexistent', { ip: '1.2.3.4' });
            // Should not throw
        });

        it('does not trigger reactivity if nothing changed', () => {
            const store = useEngineStore();
            store.setEngineInfo('eng-1', { ip: '10.0.0.1' });
            const map1 = store.engines;
            store.setEngineInfo('eng-1', { ip: '10.0.0.1' }); // same value
            // Map reference should be the same (no unnecessary reactivity trigger)
            expect(store.engines).toBe(map1);
        });
    });

    describe('engineList', () => {
        it('returns all engines as array', () => {
            const store = useEngineStore();
            store.addEngine({ engine_id: 'a', display_name: 'A', modules: {}, connections: [] });
            store.addEngine({ engine_id: 'b', display_name: 'B', modules: {}, connections: [] });
            expect(store.engineList).toHaveLength(2);
        });

        it('returns empty array when no engines', () => {
            const store = useEngineStore();
            expect(store.engineList).toEqual([]);
        });
    });

    describe('clearEngineRuntime', () => {
        it('preserves engine.running across an offline blip', () => {
            const store = useEngineStore();
            store.addEngine({
                engine_id: 'eng-1',
                display_name: 'E1',
                running: true,
                modules: {
                    'mod-1': { pluginId: 'p', displayName: 'M1', running: true, health: 'ok' },
                },
                connections: [],
            });

            store.clearEngineRuntime('eng-1');

            const engine = store.getEngine('eng-1')!;
            expect(engine.running).toBe(true);
            expect(engine.modules['mod-1'].running).toBe(false);
            expect(engine.modules['mod-1'].health).toBe('stopped');
            expect(engine.system).toBeUndefined();
        });
    });
});

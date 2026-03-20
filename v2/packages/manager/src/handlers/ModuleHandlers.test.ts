import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleHandlers } from './ModuleHandlers.js';

describe('ModuleHandlers', () => {
    let handlers: ModuleHandlers;
    let mockConfigStore: any;
    let mockEngineManager: any;
    let mockIo: any;
    let mockPluginRegistry: any;
    let profileConfig: Record<string, unknown>;
    let emittedEvents: Array<{ event: string; data: any }>;

    beforeEach(() => {
        profileConfig = { modules: {}, connections: [] };
        emittedEvents = [];

        mockConfigStore = {
            getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default', password: 'pass' }),
            createProfile: vi.fn(),
            setActiveProfile: vi.fn(),
            modifyProfileConfig: vi.fn((_eid: string, _prof: string, fn: (c: any) => any) => {
                fn(profileConfig);
                return profileConfig;
            }),
        };

        mockEngineManager = {
            isEngineOnline: vi.fn().mockReturnValue(false),
            sendToEngine: vi.fn(),
        };

        mockIo = {
            emit: vi.fn((event: string, data: any) => {
                emittedEvents.push({ event, data });
            }),
        };

        mockPluginRegistry = {
            find: vi.fn().mockReturnValue({
                pluginId: 'audio-input',
                displayName: 'Audio Input',
                ports: [{ id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Audio Out' }],
                configSchema: {
                    type: 'object',
                    properties: {
                        device: { type: 'string', default: '' },
                        sampleRate: { type: 'number', default: 48000 },
                    },
                },
                color: '#3b82f6',
                icon: 'mic',
            }),
        };

        handlers = new ModuleHandlers(mockConfigStore, mockEngineManager, mockIo, mockPluginRegistry);
    });

    describe('add', () => {
        it('creates a module with default settings from schema', () => {
            handlers.add({ engineId: 'eng-1', pluginId: 'audio-input', displayName: 'Mic 1' });

            // Check profile config was updated
            expect(Object.keys(profileConfig.modules as any)).toHaveLength(1);
            const mod = Object.values(profileConfig.modules as any)[0] as any;
            expect(mod.pluginId).toBe('audio-input');
            expect(mod.displayName).toBe('Mic 1');
            expect(mod.settings.device).toBe('');
            expect(mod.settings.sampleRate).toBe(48000);
        });

        it('broadcasts engine:update with add patch', () => {
            handlers.add({ engineId: 'eng-1', pluginId: 'audio-input', displayName: 'Mic 1' });

            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].event).toBe('engine:update');
            const patch = emittedEvents[0].data.patch[0];
            expect(patch.op).toBe('add');
            expect(patch.value.displayName).toBe('Mic 1');
            expect(patch.value.color).toBe('#3b82f6');
            expect(patch.value.icon).toBe('mic');
        });

        it('merges provided settings with defaults', () => {
            handlers.add({
                engineId: 'eng-1',
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                settings: { device: 'alsa_input.usb-mic' },
            });

            const mod = Object.values(profileConfig.modules as any)[0] as any;
            expect(mod.settings.device).toBe('alsa_input.usb-mic');
            expect(mod.settings.sampleRate).toBe(48000); // default preserved
        });

        it('creates default profile if none exists', () => {
            mockConfigStore.getEngine.mockReturnValue({ engine_id: 'eng-1', active_profile: null });
            handlers.add({ engineId: 'eng-1', pluginId: 'audio-input', displayName: 'Mic 1' });

            expect(mockConfigStore.createProfile).toHaveBeenCalledWith('eng-1', 'default', {});
            expect(mockConfigStore.setActiveProfile).toHaveBeenCalledWith('eng-1', 'default');
        });

        it('does nothing for unknown engine', () => {
            mockConfigStore.getEngine.mockReturnValue(null);
            handlers.add({ engineId: 'missing', pluginId: 'audio-input', displayName: 'Mic' });
            expect(emittedEvents).toHaveLength(0);
        });

        it('forwards config to engine if online', () => {
            mockEngineManager.isEngineOnline.mockReturnValue(true);
            handlers.add({ engineId: 'eng-1', pluginId: 'audio-input', displayName: 'Mic 1' });
            expect(mockEngineManager.sendToEngine).toHaveBeenCalledWith('eng-1', 'config', profileConfig, { guaranteeDelivery: true });
        });
    });

    describe('delete', () => {
        beforeEach(() => {
            (profileConfig.modules as any)['mod-1'] = { pluginId: 'audio-input', displayName: 'Mic 1' };
            (profileConfig.connections as any[]).push({
                id: 'mod-1:out-mod-2:in',
                sourceModuleId: 'mod-1',
                sourcePortId: 'out',
                sinkModuleId: 'mod-2',
                sinkPortId: 'in',
            });
        });

        it('removes module from config', () => {
            handlers.delete({ engineId: 'eng-1', moduleId: 'mod-1' });
            expect((profileConfig.modules as any)['mod-1']).toBeUndefined();
        });

        it('removes connections involving the module', () => {
            handlers.delete({ engineId: 'eng-1', moduleId: 'mod-1' });
            expect((profileConfig.connections as any[])).toHaveLength(0);
        });

        it('broadcasts engine:update with remove patch', () => {
            handlers.delete({ engineId: 'eng-1', moduleId: 'mod-1' });
            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].data.patch[0].op).toBe('remove');
            expect(emittedEvents[0].data.patch[0].path).toBe('/modules/mod-1');
        });
    });

    describe('config', () => {
        beforeEach(() => {
            (profileConfig.modules as any)['mod-1'] = {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                settings: { device: '', sampleRate: 48000 },
            };
        });

        it('updates module settings', () => {
            handlers.config({ engineId: 'eng-1', moduleId: 'mod-1', changes: { device: 'new-mic' } });
            const mod = (profileConfig.modules as any)['mod-1'];
            expect(mod.settings.device).toBe('new-mic');
            expect(mod.settings.sampleRate).toBe(48000); // unchanged
        });

        it('forwards moduleConfig command to engine', () => {
            mockEngineManager.isEngineOnline.mockReturnValue(true);
            handlers.config({ engineId: 'eng-1', moduleId: 'mod-1', changes: { device: 'mic-2' } });
            expect(mockEngineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'command',
                expect.objectContaining({ command: 'moduleConfig', moduleId: 'mod-1', changes: { device: 'mic-2' } }),
                { guaranteeDelivery: true },
            );
        });
    });

    describe('toggle', () => {
        beforeEach(() => {
            (profileConfig.modules as any)['mod-1'] = {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                enabled: true,
            };
        });

        it('toggles enabled module to disabled', () => {
            handlers.toggle({ engineId: 'eng-1', moduleId: 'mod-1' });
            expect((profileConfig.modules as any)['mod-1'].enabled).toBe(false);
        });

        it('toggles disabled module to enabled', () => {
            (profileConfig.modules as any)['mod-1'].enabled = false;
            handlers.toggle({ engineId: 'eng-1', moduleId: 'mod-1' });
            expect((profileConfig.modules as any)['mod-1'].enabled).toBe(true);
        });

        it('sends moduleDisable command to engine when disabling', () => {
            mockEngineManager.isEngineOnline.mockReturnValue(true);
            handlers.toggle({ engineId: 'eng-1', moduleId: 'mod-1' }); // was enabled → now disabled
            expect(mockEngineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'command',
                expect.objectContaining({ command: 'moduleDisable', moduleId: 'mod-1' }),
                { guaranteeDelivery: true },
            );
        });
    });

    describe('rename', () => {
        beforeEach(() => {
            (profileConfig.modules as any)['mod-1'] = {
                pluginId: 'audio-input',
                displayName: 'Old Name',
            };
        });

        it('updates display name', () => {
            handlers.rename({ engineId: 'eng-1', moduleId: 'mod-1', displayName: 'New Name' });
            expect((profileConfig.modules as any)['mod-1'].displayName).toBe('New Name');
        });

        it('broadcasts engine:update with replace patch', () => {
            handlers.rename({ engineId: 'eng-1', moduleId: 'mod-1', displayName: 'New Name' });
            expect(emittedEvents).toHaveLength(1);
            expect(emittedEvents[0].data.patch[0].path).toBe('/modules/mod-1/displayName');
            expect(emittedEvents[0].data.patch[0].value).toBe('New Name');
        });
    });

    describe('meta', () => {
        beforeEach(() => {
            (profileConfig.modules as any)['mod-1'] = {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
            };
        });

        it('sets focused flag', () => {
            handlers.meta({ engineId: 'eng-1', moduleId: 'mod-1', meta: { focused: true } });
            expect((profileConfig.modules as any)['mod-1'].focused).toBe(true);
        });

        it('unsets focused flag', () => {
            (profileConfig.modules as any)['mod-1'].focused = true;
            handlers.meta({ engineId: 'eng-1', moduleId: 'mod-1', meta: { focused: false } });
            expect((profileConfig.modules as any)['mod-1'].focused).toBe(false);
        });
    });
});

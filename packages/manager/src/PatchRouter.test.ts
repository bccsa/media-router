import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PatchRouter } from './PatchRouter.js';

function createMocks() {
    const configStore = {
        getEngine: vi.fn().mockReturnValue({ engine_id: 'eng-1', active_profile: 'default' }),
        modifyProfileConfig: vi.fn((engineId, profile, fn) => {
            const config = { modules: {}, connections: [] };
            return fn(config);
        }),
        getProfile: vi.fn().mockReturnValue({ modules: {}, connections: [] }),
    } as any;

    const engineManager = {
        isEngineOnline: vi.fn().mockReturnValue(true),
        sendToEngine: vi.fn(),
    } as any;

    const emitted: Array<{ event: string; data: unknown }> = [];
    const io = {
        emit: vi.fn((event: string, data: unknown) => emitted.push({ event, data })),
        except: vi.fn().mockReturnThis(),
    } as any;

    const pluginRegistry = {
        find: vi.fn().mockReturnValue({
            pluginId: 'audio-input',
            displayName: 'Audio Input',
            ports: [{ id: 'audio-out', direction: 'output', streamType: 'audio/pcm' }],
            configSchema: { properties: { volume: { default: 100 } } },
            color: '#3b82f6',
            icon: 'mic',
        }),
    } as any;

    const router = new PatchRouter(configStore, engineManager, io, pluginRegistry);
    return { router, configStore, engineManager, io, pluginRegistry, emitted };
}

describe('PatchRouter', () => {
    describe('onPatch from browser', () => {
        it('applies patch to ConfigStore', () => {
            const { router, configStore } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(configStore.modifyProfileConfig).toHaveBeenCalled();
        });

        it('broadcasts to other browsers (skip sender)', () => {
            const { router, io } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(io.except).toHaveBeenCalledWith('browser-1');
        });

        it('forwards patch to engine', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect(engineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'patch', expect.objectContaining({ ops: expect.any(Array) }), expect.any(Object),
            );
        });

        it('does not forward to engine if engine offline', () => {
            const { router, engineManager } = createMocks();
            engineManager.isEngineOnline.mockReturnValue(false);
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });
    });

    describe('onPatch from engine', () => {
        it('broadcasts to ALL browsers (not skip sender)', () => {
            const { router, io } = createMocks();
            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(io.emit).toHaveBeenCalledWith('engine:update', expect.objectContaining({
                engineId: 'eng-1',
                patch: expect.any(Array),
            }));
            // Should NOT call except (full broadcast)
            expect(io.except).not.toHaveBeenCalled();
        });

        it('does NOT forward back to engine', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('engine', 'engine', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        });
    });

    describe('patch forwarding', () => {
        it('forwards patch to engine (not old commands)', () => {
            const { router, engineManager } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            // Should send patch, not old-style commands
            expect(engineManager.sendToEngine).toHaveBeenCalledWith(
                'eng-1', 'patch',
                expect.objectContaining({ ops: expect.any(Array) }),
                expect.any(Object),
            );
            // Should NOT send old command format
            const calls = engineManager.sendToEngine.mock.calls;
            const commandCalls = calls.filter((c: any) => c[1] === 'command');
            expect(commandCalls).toHaveLength(0);
        });
    });

    describe('edge cases', () => {
        it('drops patch with no ops', () => {
            const { router, configStore } = createMocks();
            router.onPatch('browser-1', 'browser', 'eng-1', []);
            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
        });

        it('drops patch when no active profile', () => {
            const { router, configStore } = createMocks();
            configStore.getEngine.mockReturnValue({ engine_id: 'eng-1', active_profile: null });
            router.onPatch('browser-1', 'browser', 'eng-1', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(configStore.modifyProfileConfig).not.toHaveBeenCalled();
        });
    });
});

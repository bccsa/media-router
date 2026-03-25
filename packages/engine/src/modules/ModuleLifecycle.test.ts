import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleLifecycle } from './ModuleLifecycle.js';
import { ModuleManager } from './ModuleManager.js';
import { MediaRouter } from '../routing/MediaRouter.js';
import { PluginLoader } from '../plugins/PluginLoader.js';

describe('ModuleLifecycle', () => {
    let lifecycle: ModuleLifecycle;
    let moduleManager: ModuleManager;
    let mediaRouter: MediaRouter;
    let mockPipeWire: any;

    beforeEach(() => {
        const pluginLoader = new PluginLoader('/nonexistent');
        mockPipeWire = {
            loadNullSink: vi.fn().mockResolvedValue(1),
            unloadModule: vi.fn().mockResolvedValue(undefined),
            cleanupOrphans: vi.fn().mockResolvedValue(undefined),
            releaseOwnerResources: vi.fn().mockResolvedValue(undefined),
            getDeviceInfo: vi.fn().mockReturnValue(null),
            setSourceVolume: vi.fn().mockResolvedValue(undefined),
            setSinkVolume: vi.fn().mockResolvedValue(undefined),
        };

        mediaRouter = new MediaRouter();
        moduleManager = new ModuleManager(pluginLoader, mockPipeWire, mediaRouter);

        const getConfig = () => ({
            modules: {
                'mod-a': { pluginId: 'example', displayName: 'Module A', enabled: true, settings: {}, ports: [] },
                'mod-b': { pluginId: 'example', displayName: 'Module B', enabled: true, settings: {}, ports: [] },
            },
            connections: [],
        });

        lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, mockPipeWire, getConfig);
    });

    it('starts all modules from config', async () => {
        await lifecycle.startAll();
        expect(moduleManager.size).toBe(2);
        expect(moduleManager.get('mod-a')?.running).toBe(true);
        expect(moduleManager.get('mod-b')?.running).toBe(true);
    });

    it('skips disabled modules', async () => {
        const getConfig = () => ({
            modules: {
                'mod-a': { pluginId: 'example', displayName: 'A', enabled: true, settings: {}, ports: [] },
                'mod-b': { pluginId: 'example', displayName: 'B', enabled: false, settings: {}, ports: [] },
            },
            connections: [],
        });

        lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, mockPipeWire, getConfig);
        await lifecycle.startAll();

        expect(moduleManager.get('mod-a')?.running).toBe(true);
        expect(moduleManager.get('mod-b')).toBeUndefined(); // not even created
    });

    it('stopAll stops all modules but keeps them registered', async () => {
        await lifecycle.startAll();
        expect(moduleManager.size).toBe(2);

        await lifecycle.stopAll();
        // Modules are stopped but still in the map (not destroyed)
        expect(moduleManager.size).toBe(2);
        expect(moduleManager.get('mod-a')?.running).toBe(false);
        expect(moduleManager.get('mod-b')?.running).toBe(false);
    });

    it('startAll after stopAll creates fresh modules (no "already exists")', async () => {
        await lifecycle.startAll();
        await lifecycle.stopAll();

        // This should NOT throw "Module already exists"
        await lifecycle.startAll();
        expect(moduleManager.size).toBe(2);
        expect(moduleManager.get('mod-a')?.running).toBe(true);
    });

    it('does nothing when config is null', async () => {
        lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, mockPipeWire, () => null);
        await lifecycle.startAll();
        expect(moduleManager.size).toBe(0);
    });

    it('does nothing when config has no modules', async () => {
        lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, mockPipeWire, () => ({ modules: {}, connections: [] }));
        await lifecycle.startAll();
        expect(moduleManager.size).toBe(0);
    });

    describe('reset flow (stopAll → cleanupOrphans → startAll)', () => {
        it('full reset cycle works: stop → cleanup → start', async () => {
            // Start modules
            await lifecycle.startAll();
            expect(moduleManager.size).toBe(2);
            expect(moduleManager.get('mod-a')?.running).toBe(true);

            // Stop all (simulates first half of reset)
            await lifecycle.stopAll();
            expect(moduleManager.get('mod-a')?.running).toBe(false);

            // Cleanup orphans (simulates PipeWire restart cleanup)
            await mockPipeWire.cleanupOrphans();
            expect(mockPipeWire.cleanupOrphans).toHaveBeenCalled();

            // Start all again (simulates second half of reset)
            await lifecycle.startAll();
            expect(moduleManager.size).toBe(2);
            expect(moduleManager.get('mod-a')?.running).toBe(true);
            expect(moduleManager.get('mod-b')?.running).toBe(true);
        });

        it('rapid stop→start does not cause "already exists" error', async () => {
            await lifecycle.startAll();
            await lifecycle.stopAll();
            // Immediately start again — should destroy old modules and create fresh ones
            await lifecycle.startAll();
            expect(moduleManager.size).toBe(2);
        });
    });

    describe('port registration fallback', () => {
        it('uses config ports when available', async () => {
            const configPorts = [
                { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Audio Out' },
            ];
            const getConfig = () => ({
                modules: {
                    'mic-1': { pluginId: 'example', displayName: 'Mic', enabled: true, settings: {}, ports: configPorts },
                },
                connections: [],
            });

            lifecycle = new ModuleLifecycle(moduleManager, mediaRouter, mockPipeWire, getConfig);
            await lifecycle.startAll();

            // Port should be registered from config
            const port = mediaRouter.portRegistry.get('mic-1', 'audio-out');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('audio/pcm');
        });

        it('falls back to plugin manifest ports when config ports are empty', async () => {
            // Create a mock PluginLoader that returns manifest ports
            const mockPluginLoader = {
                get: vi.fn().mockReturnValue({
                    manifest: {
                        pluginId: 'example',
                        displayName: 'Example',
                        ports: [
                            { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Audio Out' },
                        ],
                    },
                }),
                loadAll: vi.fn(),
            } as any;

            const getConfig = () => ({
                modules: {
                    'mic-1': { pluginId: 'example', displayName: 'Mic', enabled: true, settings: {}, ports: [] },
                },
                connections: [],
            });

            // Recreate moduleManager with the mock plugin loader
            const mm = new ModuleManager(mockPluginLoader, mockPipeWire, mediaRouter);
            const lc = new ModuleLifecycle(mm, mediaRouter, mockPipeWire, getConfig, mockPluginLoader);
            await lc.startAll();

            // Port should be registered from plugin manifest fallback
            const port = mediaRouter.portRegistry.get('mic-1', 'audio-out');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('audio/pcm');
        });

        it('falls back to plugin manifest ports when config has no ports field', async () => {
            const mockPluginLoader = {
                get: vi.fn().mockReturnValue({
                    manifest: {
                        pluginId: 'example',
                        displayName: 'Example',
                        ports: [
                            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'MPEG-TS Out' },
                        ],
                    },
                }),
                loadAll: vi.fn(),
            } as any;

            const getConfig = () => ({
                modules: {
                    'enc-1': { pluginId: 'example', displayName: 'Encoder', enabled: true, settings: {} },
                    // Note: no 'ports' field at all
                },
                connections: [],
            });

            const mm = new ModuleManager(mockPluginLoader, mockPipeWire, mediaRouter);
            const lc = new ModuleLifecycle(mm, mediaRouter, mockPipeWire, getConfig, mockPluginLoader);
            await lc.startAll();

            const port = mediaRouter.portRegistry.get('enc-1', 'mpegts-out');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('muxed/mpegts');
        });
    });

    describe('startSingle — port fallback', () => {
        it('uses manifest ports when config has none', async () => {
            const mockPluginLoader = {
                get: vi.fn().mockReturnValue({
                    manifest: {
                        pluginId: 'example',
                        displayName: 'Example',
                        ports: [
                            { id: 'audio-out', direction: 'output', streamType: 'audio/pcm', label: 'Audio Out' },
                        ],
                    },
                }),
            } as any;

            const getConfig = () => ({
                modules: {
                    'mic-2': { pluginId: 'example', displayName: 'Mic 2', enabled: true, settings: {} },
                },
                connections: [],
            });

            const mm = new ModuleManager(mockPluginLoader, mockPipeWire, mediaRouter);
            const lc = new ModuleLifecycle(mm, mediaRouter, mockPipeWire, getConfig, mockPluginLoader);
            await lc.startSingle('mic-2');

            const port = mediaRouter.portRegistry.get('mic-2', 'audio-out');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('audio/pcm');
        });
    });

    describe('enable — port fallback', () => {
        it('uses manifest ports when config has none', async () => {
            const mockPluginLoader = {
                get: vi.fn().mockReturnValue({
                    manifest: {
                        pluginId: 'example',
                        displayName: 'Example',
                        ports: [
                            { id: 'audio-in', direction: 'input', streamType: 'audio/pcm', label: 'Audio In' },
                        ],
                    },
                }),
            } as any;

            const getConfig = () => ({
                modules: {
                    'out-1': { pluginId: 'example', displayName: 'Output', enabled: false, settings: {} },
                },
                connections: [],
            });

            const mm = new ModuleManager(mockPluginLoader, mockPipeWire, mediaRouter);
            const lc = new ModuleLifecycle(mm, mediaRouter, mockPipeWire, getConfig, mockPluginLoader);
            await lc.enable('out-1');

            const port = mediaRouter.portRegistry.get('out-1', 'audio-in');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('audio/pcm');
        });
    });

    describe('resolvePorts — MPEG-TS classification', () => {
        it('resolves MPEG-TS ports from manifest when config has none', async () => {
            const mockPluginLoader = {
                get: vi.fn().mockReturnValue({
                    manifest: {
                        pluginId: 'srt-input',
                        displayName: 'SRT Input',
                        ports: [
                            { id: 'mpegts-out', direction: 'output', streamType: 'muxed/mpegts', label: 'MPEG-TS Out' },
                        ],
                    },
                }),
            } as any;

            // Config has no ports field — resolvePorts must use manifest
            const getConfig = () => ({
                modules: {
                    'srt-1': { pluginId: 'srt-input', displayName: 'SRT Input', enabled: true, settings: {} },
                },
                connections: [],
            });

            const mm = new ModuleManager(mockPluginLoader, mockPipeWire, mediaRouter);
            const lc = new ModuleLifecycle(mm, mediaRouter, mockPipeWire, getConfig, mockPluginLoader);
            await lc.startAll();

            // Port should be registered from manifest with correct streamType
            const port = mediaRouter.portRegistry.get('srt-1', 'mpegts-out');
            expect(port).toBeDefined();
            expect(port!.streamType).toBe('muxed/mpegts');
            expect(port!.direction).toBe('output');
        });
    });
});

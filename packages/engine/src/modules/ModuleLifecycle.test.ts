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
});

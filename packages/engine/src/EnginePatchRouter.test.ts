import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnginePatchRouter } from './EnginePatchRouter.js';

function createMocks() {
    const config: Record<string, unknown> = {
        modules: {
            'mod-1': { pluginId: 'audio-input', displayName: 'Mic', settings: { volume: 100 } },
        },
        connections: [],
    };

    const moduleManager = {
        applyConfigUpdate: vi.fn(async () => {}),
    } as any;

    const mediaRouter = {
        createConnection: vi.fn(async () => 'conn-1'),
        removeConnection: vi.fn(async () => true),
        updateChannelMap: vi.fn(async () => {}),
    } as any;

    const lcpServer = {
        broadcastConfigUpdate: vi.fn(),
        broadcastConfigUpdateExcept: vi.fn(),
    } as any;

    const managerConnection = {
        isConnected: true,
        send: vi.fn(),
    } as any;

    const lifecycle = {
        startSingle: vi.fn(async () => {}),
        deleteSingle: vi.fn(async () => {}),
        enable: vi.fn(async () => {}),
        disable: vi.fn(async () => {}),
    } as any;

    const router = new EnginePatchRouter(
        moduleManager, mediaRouter, lcpServer,
        managerConnection, lifecycle,
        () => config,
    );

    return { router, config, moduleManager, mediaRouter, lcpServer, managerConnection, lifecycle };
}

describe('EnginePatchRouter', () => {
    describe('onPatch from manager', () => {
        it('applies patch to config', () => {
            const { router, config } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'New Name' },
            ]);
            expect((config.modules as any)['mod-1'].displayName).toBe('New Name');
        });

        it('broadcasts to ALL LCPs', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(lcpServer.broadcastConfigUpdate).toHaveBeenCalledWith([
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
        });

        it('does NOT forward back to manager', () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/displayName', value: 'X' },
            ]);
            expect(managerConnection.send).not.toHaveBeenCalled();
        });
    });

    describe('onPatch from LCP', () => {
        it('applies patch to config', () => {
            const { router, config } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect((config.modules as any)['mod-1'].settings.volume).toBe(50);
        });

        it('broadcasts to other LCPs (skip sender)', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            expect(lcpServer.broadcastConfigUpdateExcept).toHaveBeenCalledWith('lcp-1', expect.any(Array));
        });

        it('debounced forwards to manager', async () => {
            const { router, managerConnection } = createMocks();
            router.onPatch('lcp-1', 'lcp', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 50 },
            ]);
            // Not sent yet (debounced)
            expect(managerConnection.send).not.toHaveBeenCalled();
            // Wait for debounce
            await new Promise((r) => setTimeout(r, 150));
            expect(managerConnection.send).toHaveBeenCalledWith('patch', expect.objectContaining({ ops: expect.any(Array) }));
        });
    });

    describe('side effects', () => {
        it('applies live config update for settings change', () => {
            const { router, moduleManager } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'replace', path: '/modules/mod-1/settings/volume', value: 80 },
            ]);
            expect(moduleManager.applyConfigUpdate).toHaveBeenCalledWith('mod-1', { volume: 80 });
        });

        it('triggers connection creation for connection add', () => {
            const { router, mediaRouter } = createMocks();
            router.onPatch('manager', 'manager', [
                { op: 'add', path: '/connections/-', value: { sourceModuleId: 'a', sourcePortId: 'out', sinkModuleId: 'b', sinkPortId: 'in' } },
            ]);
            expect(mediaRouter.createConnection).toHaveBeenCalledWith('a', 'out', 'b', 'in', undefined);
        });
    });

    describe('edge cases', () => {
        it('drops patch with no ops', () => {
            const { router, lcpServer } = createMocks();
            router.onPatch('manager', 'manager', []);
            expect(lcpServer.broadcastConfigUpdate).not.toHaveBeenCalled();
        });

        it('drops patch when no config', () => {
            const moduleManager = {} as any;
            const mediaRouter = {} as any;
            const lcpServer = { broadcastConfigUpdate: vi.fn() } as any;
            const managerConnection = { isConnected: false, send: vi.fn() } as any;
            const lifecycle = {} as any;
            const router = new EnginePatchRouter(moduleManager, mediaRouter, lcpServer, managerConnection, lifecycle, () => null);
            router.onPatch('manager', 'manager', [{ op: 'replace', path: '/x', value: 1 }]);
            expect(lcpServer.broadcastConfigUpdate).not.toHaveBeenCalled();
        });
    });
});

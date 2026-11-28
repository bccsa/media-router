import { describe, it, expect, vi } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { EnginePatchRouter } from './EnginePatchRouter.js';
import { applyConfigPush, type ConfigPushDeps } from './comms/applyConfigPush.js';
import { LocalChanges } from './comms/LocalChanges.js';

// The routing editor's layout (`editor`, ADR-0030) reaches the router like
// module positions: stored, passed on to its tree, and otherwise ignored.

const layout = (name: string) => ({
    pages: { 'pg-a': { name, order: 0 } },
    modulePages: { 'mod-1': 'pg-a' },
    refs: { 'out:mod-1:audio-out': { n: 1 } },
    tagged: { 'conn-1': true },
    nextRef: 2,
});

function patchRouter() {
    const config: Record<string, unknown> = {
        modules: { 'mod-1': { pluginId: 'audio-input', settings: { volume: 100 } } },
        connections: [
            {
                id: 'conn-1',
                sourceModuleId: 'mod-1',
                sourcePortId: 'audio-out',
                sinkModuleId: 'mod-2',
                sinkPortId: 'in',
            },
        ],
    };
    const moduleManager = { applyConfigUpdate: vi.fn(async () => {}) };
    const mediaRouter = {
        createConnection: vi.fn(),
        removeConnection: vi.fn(),
        updateChannelMap: vi.fn(),
        isConnectionWaiting: vi.fn(),
    };
    const lifecycle = {
        refreshPorts: vi.fn(),
        startSingle: vi.fn(),
        deleteSingle: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
    };
    const localServer = { configChanged: vi.fn() };
    const localChanges = { config: vi.fn() };
    const router = new EnginePatchRouter(
        moduleManager as any,
        mediaRouter as any,
        localServer as any,
        localChanges as any,
        lifecycle as any,
        () => config,
        () => true,
    );
    const sideEffects = [
        ...Object.values(moduleManager),
        ...Object.values(mediaRouter),
        ...Object.values(lifecycle),
    ];
    return { router, config, sideEffects, localServer, localChanges };
}

describe('the editor namespace on the router', () => {
    it('an /editor patch from the manager is stored and passed on, with no lifecycle or routing call', async () => {
        const { router, config, sideEffects, localServer, localChanges } = patchRouter();
        const ops: PatchOp[] = [
            { op: 'add', path: '/editor', value: layout('Main') },
            { op: 'add', path: '/editor/pages/pg-b', value: { name: 'Second', order: 1 } },
            { op: 'replace', path: '/editor/modulePages/mod-1', value: 'pg-b' },
            { op: 'add', path: '/editor/refs/in:mod-2:in', value: { n: 2 } },
            { op: 'replace', path: '/editor/nextRef', value: 3 },
            { op: 'remove', path: '/editor/tagged/conn-1' },
            { op: 'replace', path: '/editor/refs/out:mod-1:audio-out/pos', value: { x: 1, y: 2 } },
        ];
        router.onPatch('manager', 'manager', ops);
        await new Promise((r) => setTimeout(r, 10));
        expect(config.editor).toEqual({
            pages: { 'pg-a': { name: 'Main', order: 0 }, 'pg-b': { name: 'Second', order: 1 } },
            modulePages: { 'mod-1': 'pg-b' },
            refs: { 'out:mod-1:audio-out': { n: 1, pos: { x: 1, y: 2 } }, 'in:mod-2:in': { n: 2 } },
            tagged: {},
            nextRef: 3,
        });
        for (const fn of sideEffects) expect(fn).not.toHaveBeenCalled();
        expect(localServer.configChanged).toHaveBeenCalledWith(ops);
        expect(localChanges.config).not.toHaveBeenCalled();
        expect((config.connections as unknown[]).length).toBe(1);
    });

    it('a config push carrying editor stores it, with no module diff, rebuild or restart', () => {
        const running = () => ({
            modules: { m1: { pluginId: 'mixer', settings: { volume: 100 } } },
            connections: [],
            running: true,
        });
        let current: Record<string, unknown> | null = { ...running(), editor: layout('Old') };
        const localChanges = new LocalChanges({ isConnected: true, send: vi.fn() });
        localChanges.profile = 'p';
        const deps: ConfigPushDeps = {
            localChanges,
            getConfig: () => current,
            setConfig: vi.fn((c) => (current = c)),
            isRunning: () => true,
            applyOps: vi.fn(),
            broadcastConfig: vi.fn(),
            restartAll: vi.fn(),
            schemas: () => ({}),
        };
        const before = current;
        applyConfigPush(deps, {
            ...running(),
            editor: layout('New'),
            _push: { reason: 'connect', profile: 'p' },
        });
        expect(current).toBe(before);
        expect(current!.editor).toEqual(layout('New'));
        expect(deps.applyOps).not.toHaveBeenCalled();
        expect(deps.setConfig).not.toHaveBeenCalled();
        expect(deps.restartAll).not.toHaveBeenCalled();

        applyConfigPush(deps, {
            ...running(),
            editor: layout('Activated'),
            _push: { reason: 'activate', profile: 'p' },
        });
        expect(current!.editor).toEqual(layout('Activated'));
        expect(deps.applyOps).not.toHaveBeenCalled();
        expect(deps.restartAll).not.toHaveBeenCalled();
    });
});

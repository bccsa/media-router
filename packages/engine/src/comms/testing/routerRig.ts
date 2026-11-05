// A router for the manager-link integration tests (#857), not shipped: the engine's
// own comms, patch router, wiring, router tree and LCP server on a real HTTP server;
// only the modules are stand-ins (no GStreamer).
import { EventEmitter } from 'events';
import type { AddressInfo } from 'net';
import { ManagerConnection } from '../ManagerConnection.js';
import { LocalChanges } from '../LocalChanges.js';
import { LocalServer } from '../LocalServer.js';
import { LcpServer } from '../LcpServer.js';
import { EnginePatchRouter } from '../../EnginePatchRouter.js';
import { wireEngineEvents } from '../../EngineEventWiring.js';
import { createRouterTree } from '../../tree/createRouterTree.js';

/** The host schema of the stand-in modules' plugin. */
export const SCHEMA = {
    properties: {
        volume: { type: 'number', minimum: 0, maximum: 150, 'x-live': true },
        volumeMax: { type: 'number' },
        audioEnabled: { type: 'boolean', 'x-live': true },
    },
};

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(what: string, ms: number, check: () => boolean): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await sleep(10);
    }
}

/** Starts the router and connects it to the manager's dgram port; resolves after its first push. */
export async function startRouter(name: string, managerPort: number) {
    const mc = new ManagerConnection();
    const sent: string[] = [];
    const send = mc.send.bind(mc);
    mc.send = (topic, message, options) => {
        sent.push(topic);
        send(topic, message, options);
    };
    const links: Array<{ resumed: boolean }> = [];
    let pushes = 0;
    let hellos = 0;
    mc.on('connected', (link: { resumed: boolean }) => links.push(link));
    mc.on('config', () => pushes++);
    mc.on('hello', () => hellos++);
    const localChanges = new LocalChanges(mc);
    const localServer = new LocalServer(0, { viewer: [], lcp: [] });
    const lcpServer = new LcpServer();
    let config: Record<string, any> | null = null;
    const states: Record<string, any> = {
        m1: { running: true, ready: true, health: 'ok', pendingRestart: false },
    };
    const moduleManager = Object.assign(new EventEmitter(), {
        getAllStates: () => states,
        applyConfigUpdate: async () => {},
        get: (id: string) => (states[id] ? { getState: () => states[id] } : undefined),
    });
    const runController = { isRunning: true };
    const commandDispatcher = {
        dispatch: (c: { command: string; moduleId?: string }) => {
            if (c.command === 'start' || c.command === 'stop')
                runController.isRunning = c.command === 'start';
            // A module restart, as the module's state reports it.
            if (c.command === 'moduleRestart' && c.moduleId) {
                states[c.moduleId] = { ...states[c.moduleId], ready: false, health: 'starting' };
                moduleManager.emit('stateChange', c.moduleId, states[c.moduleId]);
            }
        },
    };
    const noop = async () => {};
    const lifecycle = {
        refreshPorts: () => {},
        enable: noop,
        disable: noop,
        startSingle: noop,
        deleteSingle: noop,
    };
    const patchRouter = new EnginePatchRouter(
        moduleManager as any,
        {} as any,
        localServer,
        localChanges,
        lifecycle as any,
        () => config,
        () => runController.isRunning,
    );
    const routerTree = createRouterTree({
        config: () => config,
        pluginLoader: {
            get: () => ({ manifest: { ports: [] } }),
            getPluginSchemas: () => ({ 'audio-output': SCHEMA }),
        } as any,
        moduleManager: moduleManager as any,
        profileStore: { getActive: () => ({ name }) } as any,
        runController: () => runController as any,
        managerConnection: mc,
        commandDispatcher: () => commandDispatcher as any,
        localChanges,
        patch: (senderId, ops) => patchRouter.onPatch(senderId, 'local', ops),
        device: { ips: [], hostname: 'router-one', buildNumber: undefined },
        build: () => 'test',
    });
    wireEngineEvents({
        logForwarder: new EventEmitter() as any,
        moduleManager: moduleManager as any,
        managerConnection: mc,
        localServer,
        lcpServer,
        pipeWire: {} as any,
        deviceProviders: Object.assign(new EventEmitter(), {
            types: () => [],
            getDevices: async () => [],
            resetSnapshots: () => {},
        }) as any,
        commandDispatcher: commandDispatcher as any,
        enginePatchRouter: patchRouter,
        runController: runController as any,
        getCurrentConfig: () => config,
        setCurrentConfig: (c) => {
            config = c;
        },
        enrichConfigForLcp: (c) => c,
        refreshModulePorts: () => {},
        pluginSchemas: () => ({ 'audio-output': SCHEMA }),
        routerTree,
        localChanges,
    });
    lcpServer.attach(localServer.http);
    await localServer.start();
    routerTree.attach(localServer.http);
    mc.connect({ name, paths: [{ host: '127.0.0.1', port: managerPort }], encryptionKey: 'pw' });
    await until('the connect push and the hello', 10_000, () => config !== null && hellos > 0);

    return {
        mc,
        sent,
        links,
        url: `http://127.0.0.1:${(localServer.http.address() as AddressInfo).port}`,
        pushes: () => pushes,
        running: () => runController.isRunning,
        config: () => config as Record<string, any>,
        async close() {
            patchRouter.destroy();
            mc.disconnect();
            await routerTree.close();
            await lcpServer.close();
            await localServer.stop();
        },
    };
}

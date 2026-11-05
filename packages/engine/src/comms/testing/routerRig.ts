// A router for the manager-link integration tests (#857), not shipped: the engine's
// own comms, patch router, wiring, router tree and LCP server on a real HTTP server;
// the modules are stand-ins (no GStreamer), or with `plugins` its own over stand-in plugins.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import {
    parseManifestTiming,
    withIngestTimingSettings,
    type PatchOp,
} from '@media-router/shared-types';
import { ManagerConnection } from '../ManagerConnection.js';
import { LocalChanges } from '../LocalChanges.js';
import { LocalServer } from '../LocalServer.js';
import { LcpServer } from '../LcpServer.js';
import { EnginePatchRouter } from '../../EnginePatchRouter.js';
import { wireEngineEvents } from '../../EngineEventWiring.js';
import { createRouterTree } from '../../tree/createRouterTree.js';
import { ModuleManager } from '../../modules/ModuleManager.js';
import { ModuleLifecycle } from '../../modules/ModuleLifecycle.js';

/** The host schema of the stand-in modules' plugin. */
export const SCHEMA = {
    properties: {
        volume: { type: 'number', minimum: 0, maximum: 150, 'x-live': true },
        volumeMax: { type: 'number' },
        audioEnabled: { type: 'boolean', 'x-live': true },
    },
};

/** A plugin as this engine loads it, for a router whose modules are real (MR-035). */
export interface RigPlugin {
    schema: Record<string, unknown>;
    ports: unknown[];
    /** Its class's live keys. */
    live: string[];
}

/** A plugin of this repo as PluginLoader reads it (timing settings added), live by x-live. */
export function repoPlugin(pluginId: string): RigPlugin {
    const file = path.resolve(__dirname, '../../../../../plugins', pluginId, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')).mediaRouter;
    const timing = parseManifestTiming(manifest.timing);
    const schema = timing
        ? withIngestTimingSettings(manifest.configSchema, timing)
        : manifest.configSchema;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const live = Object.keys(props).filter(
        (k) => props[k]['x-live'] === true || props[k]['x-liveUpdatable'] === true,
    );
    return { schema, ports: manifest.ports ?? [], live };
}

/** Runs nothing; keeps the settings object a start hands it, as GstPluginBase does. */
export class StandInPlugin extends EventEmitter {
    config: Record<string, unknown> = {};
    readonly liveChanges: Record<string, unknown>[] = [];
    constructor(private readonly live: string[]) {
        super();
    }
    async onInit(config: Record<string, unknown>) {
        this.config = config;
    }
    async onStart() {}
    async onStop() {}
    async onDestroy() {}
    getState() {
        return { running: true, ready: true, health: 'ok' as const, pendingRestart: false };
    }
    getLiveUpdatableParams() {
        return this.live;
    }
    async onLiveConfigUpdate(changes: Record<string, unknown>) {
        this.liveChanges.push(changes);
        Object.assign(this.config, changes);
    }
}

/** The engine's own ModuleManager and ModuleLifecycle over stand-in plugins. */
function realModules(
    plugins: Record<string, RigPlugin>,
    getConfig: () => Record<string, unknown> | null,
) {
    const loaded = Object.fromEntries(
        Object.entries(plugins).map(([id, p]) => [
            id,
            {
                manifest: { pluginId: id, configSchema: p.schema, ports: p.ports },
                ModuleClass: class extends StandInPlugin {
                    constructor() {
                        super(p.live);
                    }
                },
            },
        ]),
    );
    const pluginLoader = {
        get: (id: string) => loaded[id],
        getPluginSchemas: () =>
            Object.fromEntries(Object.entries(plugins).map(([id, p]) => [id, p.schema])),
        settle: async () => {},
    };
    const noop = () => {};
    const mediaRouter = {
        setConsumerRestartCallback: noop,
        setWaitingScheduler: noop,
        registerPorts: noop,
        unregisterAll: noop,
        unregisterPorts: async () => {},
        removeAllConnections: async () => {},
        removeConnection: async () => true,
        getModuleConnections: () => [],
    };
    const moduleManager = new ModuleManager(pluginLoader as any);
    const lifecycle = new ModuleLifecycle(
        moduleManager,
        mediaRouter as any,
        { cleanupOrphans: async () => {} } as any,
        getConfig,
        pluginLoader as any,
    );
    return { pluginLoader, moduleManager, lifecycle };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(what: string, ms: number, check: () => boolean): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await sleep(10);
    }
}

/**
 * Starts the router and connects it to the manager's dgram port; resolves after its first push.
 * With `plugins`, the engine's own modules over stand-in plugins, started by `startModules`.
 */
export async function startRouter(
    name: string,
    managerPort: number,
    plugins?: Record<string, RigPlugin>,
) {
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
    const real = plugins ? realModules(plugins, () => config) : undefined;
    const states: Record<string, any> = {
        m1: { running: true, ready: true, health: 'ok', pendingRestart: false },
    };
    const moduleManager =
        real?.moduleManager ??
        Object.assign(new EventEmitter(), {
            getAllStates: () => states,
            applyConfigUpdate: async () => {},
            get: (id: string) => (states[id] ? { getState: () => states[id] } : undefined),
        });
    const runController = { isRunning: true };
    const commandDispatcher = {
        dispatch: (c: { command: string; moduleId?: string }) => {
            if (c.command === 'start' || c.command === 'stop')
                runController.isRunning = c.command === 'start';
            if (c.command !== 'moduleRestart' || !c.moduleId) return;
            if (real) return void real.lifecycle.restart(c.moduleId);
            // A module restart, as the module's state reports it.
            states[c.moduleId] = { ...states[c.moduleId], ready: false, health: 'starting' };
            moduleManager.emit('stateChange', c.moduleId, states[c.moduleId]);
        },
    };
    const noop = async () => {};
    const lifecycle = real?.lifecycle ?? {
        refreshPorts: () => {},
        enable: noop,
        disable: noop,
        startSingle: noop,
        deleteSingle: noop,
    };
    const pluginLoader = real?.pluginLoader ?? {
        get: () => ({ manifest: { ports: [] } }),
        getPluginSchemas: () => ({ 'audio-output': SCHEMA }),
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
    /** Each batch from the manager's side: its patches and a reconnect's difference. */
    const fromManager: PatchOp[][] = [];
    const onPatch = patchRouter.onPatch.bind(patchRouter);
    patchRouter.onPatch = (senderId, senderType, ops) => {
        if (senderType === 'manager') fromManager.push(ops);
        onPatch(senderId, senderType, ops);
    };
    const routerTree = createRouterTree({
        config: () => config,
        pluginLoader: pluginLoader as any,
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
        refreshModulePorts: (id) => real?.lifecycle.refreshPorts(id),
        pluginSchemas: () => pluginLoader.getPluginSchemas(),
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
        fromManager,
        /** Creates and starts every enabled module of the config, as the engine's start does. */
        startModules: () => real!.lifecycle.startAll(),
        module: (id: string) => real!.moduleManager.get(id)!,
        plugin: (id: string) =>
            real!.moduleManager.get(id)!.getPlugin() as unknown as StandInPlugin,
        async close() {
            patchRouter.destroy();
            await real?.moduleManager.destroyAll();
            mc.disconnect();
            await routerTree.close();
            await lcpServer.close();
            await localServer.stop();
        },
    };
}

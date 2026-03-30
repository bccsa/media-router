import type { FastifyInstance } from 'fastify';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger, formatError } from '@media-router/shared-types';

import { PluginLoader } from './plugins/PluginLoader.js';
import { ModuleManager } from './modules/ModuleManager.js';
import { MediaRouter } from './routing/MediaRouter.js';
import { ManagerConnection } from './comms/ManagerConnection.js';
import { LcpServer } from './comms/LcpServer.js';
import { LcpControlHandler } from './comms/LcpControlHandler.js';
import { ProfileStore } from './api/ProfileStore.js';
import { PipeWireManager } from './audio/PipeWireManager.js';
import { ProcessManager } from './child-process/ProcessManager.js';
import { PaCommandQueue } from './audio/PaCommandQueue.js';
import { createApiServer } from './api/server.js';
import { LogForwarder } from './logging/LogForwarder.js';
import { CommandDispatcher } from './commands/CommandDispatcher.js';
import { SystemStatsCollector } from './system/SystemStatsCollector.js';
import { getAllIps, findBuildNumber, getHostname } from './system/deviceInfo.js';
import { ModuleLifecycle } from './modules/ModuleLifecycle.js';

const log = createLogger('Engine');

export interface EngineConfig {
    apiPort?: number;
    lcpPort?: number;
    pluginsDir?: string;
    profilesPath?: string;
}

/**
 * Main engine orchestrator.
 *
 * Business logic lives in:
 * - commands/CommandDispatcher.ts  — manager command handling
 * - system/SystemStatsCollector.ts — CPU/mem/temp reporting
 * - modules/ModuleManager.ts       — module lifecycle
 * - routing/MediaRouter.ts          — connection graph + execution
 * - audio/PipeWireManager.ts        — PipeWire abstraction
 */
export class Engine {
    readonly pluginLoader: PluginLoader;
    readonly moduleManager: ModuleManager;
    readonly mediaRouter: MediaRouter;
    readonly managerConnection: ManagerConnection;
    readonly lcpServer: LcpServer;
    readonly profileStore: ProfileStore;
    readonly pipeWire: PipeWireManager;
    readonly processManager: ProcessManager;
    readonly paQueue: PaCommandQueue;

    private apiServer: FastifyInstance | null = null;
    private config: EngineConfig;
    private _running = false;
    private logForwarder: LogForwarder;
    private commandDispatcher: CommandDispatcher;
    private systemStats: SystemStatsCollector;
    private lifecycle: ModuleLifecycle;

    /** Last config received from manager. */
    private currentConfig: Record<string, unknown> | null = null;
    private lcpControlHandler: LcpControlHandler | null = null;
    /** Cached device info — computed once at construction. */
    private readonly deviceIps = getAllIps();
    private readonly deviceHostname = getHostname();
    private readonly deviceBuildNumber = findBuildNumber() || undefined;

    get running(): boolean {
        return this._running;
    }

    constructor(config: EngineConfig = {}) {
        this.config = config;

        this.logForwarder = new LogForwarder();

        // Audio subsystem
        this.paQueue = new PaCommandQueue();
        this.pipeWire = new PipeWireManager(this.paQueue);
        this.processManager = new ProcessManager();

        this.pluginLoader = new PluginLoader(config.pluginsDir);
        this.mediaRouter = new MediaRouter();
        this.moduleManager = new ModuleManager(this.pluginLoader, this.pipeWire, this.mediaRouter, this.processManager);
        this.managerConnection = new ManagerConnection();
        this.lcpServer = new LcpServer(config.lcpPort ?? 8081);
        this.lcpServer._getInitData = () => this.getLcpInitData();
        this.profileStore = new ProfileStore(config.profilesPath);

        this.mediaRouter.setDependencies(
            this.pipeWire,
            (id) => this.moduleManager.get(id),
            (id) => {
                const modules = (this.currentConfig?.modules ?? {}) as Record<string, Record<string, unknown>>;
                return (modules[id]?.displayName as string) ?? id;
            },
        );

        // Command dispatcher
        this.commandDispatcher = new CommandDispatcher({
            moduleManager: this.moduleManager,
            mediaRouter: this.mediaRouter,
            lcpServer: this.lcpServer,
            startModules: async () => {
                await this.lifecycle.startAll();
                this.lcpServer.broadcastEngineRunning(true);
            },
            stopModules: async () => {
                await this.lifecycle.stopAll();
                this.lcpServer.broadcastEngineRunning(false);
            },
            resetEngine: () => this.resetEngine(),
            restartModule: (id) => this.lifecycle.restart(id),
            startSingleModule: (id) => this.lifecycle.startSingle(id),
            deleteSingleModule: (id) => this.lifecycle.deleteSingle(id),
            disableModule: (id) => this.lifecycle.disable(id),
            enableModule: (id) => this.lifecycle.enable(id),
        });

        // Module lifecycle
        this.lifecycle = new ModuleLifecycle(
            this.moduleManager, this.mediaRouter, this.pipeWire,
            () => this.currentConfig,
            this.pluginLoader,
        );

        // When a module generates dynamic ports, push them to the manager + LCP
        this.lifecycle.onDynamicPortsResolved = (moduleId, ports) => {
            log.info({ moduleId, portCount: ports.length }, 'Dynamic ports resolved — pushing to manager');
            this.managerConnection.send('dynamicPorts', { moduleId, ports });
            this.lcpServer.broadcastConfigUpdate([
                { op: 'replace', path: `/modules/${moduleId}/ports`, value: ports },
            ]);
        };

        // System stats
        this.systemStats = new SystemStatsCollector((stats) => {
            this.managerConnection.send('system', stats);
        });

        this.wireEvents();
    }

    // --- Event wiring (thin — delegates to dispatcher) ---

    private wireEvents(): void {
        this.logForwarder.on('logs', (batch: unknown[]) => {
            if (this.managerConnection.isConnected) {
                this.managerConnection.send('logs', batch);
            }
        });

        this.moduleManager.on('stateChange', (instanceId: string, state: ModuleRuntimeState) => {
            this.managerConnection.sendState({ [instanceId]: state });
            this.lcpServer.broadcastState(instanceId, state);
        });

        this.moduleManager.on('configUpdated', (instanceId: string, changes: Record<string, unknown>) => {
            log.trace({ instanceId, changes }, 'Plugin auto-detected config');
            this.managerConnection.send('configUpdated', { instanceId, changes });
        });

        // VU data with dedup + heartbeat
        const lastVu = new Map<string, string>();
        const lastVuSent = new Map<string, number>();
        this.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
            const key = JSON.stringify(data);
            const prev = lastVu.get(instanceId);
            const lastSent = lastVuSent.get(instanceId) ?? 0;
            const now = Date.now();
            if (key !== prev || now - lastSent >= 1000) {
                lastVu.set(instanceId, key);
                lastVuSent.set(instanceId, now);
                this.managerConnection.sendVu(instanceId, data);
                this.lcpServer.broadcastVuData(instanceId, data);
            }
        });

        this.managerConnection.on('config', (config: unknown) => {
            log.info('Received config from manager');
            this.currentConfig = config as Record<string, unknown>;
            // Enrich with lcpType before broadcasting to LCP clients
            const enriched = this.enrichConfigForLcp(this.currentConfig);
            this.lcpServer.broadcastConfigUpdate([{ op: 'replace', path: '/', value: enriched }]);
        });

        this.managerConnection.on('command', (command: unknown) => {
            this.commandDispatcher.dispatch(command as Record<string, unknown>);
        });

        // LCP control commands handled by dedicated class
        this.lcpControlHandler = new LcpControlHandler({
            lcpServer: this.lcpServer,
            managerConnection: this.managerConnection,
            moduleManager: this.moduleManager,
            commandDispatcher: this.commandDispatcher,
        });

        // configRequested removed — replaced by 'init' event on connect

        this.managerConnection.on('connected', () => {
            this.systemStats.start();
            // Tell the manager whether the engine is already running
            this.managerConnection.send('engineRunningState', { running: this._running });
            const states = this.moduleManager.getAllStates();
            if (Object.keys(states).length > 0) {
                this.managerConnection.sendState(states);
            }
            // Send audio device list so the manager can serve it to browsers
            try {
                const devices = this.pipeWire.listDevices();
                this.managerConnection.send('audioDevices', devices);
            } catch { /* best effort */ }
        });
        this.managerConnection.on('disconnected', () => {
            this.systemStats.stop();
        });
    }

    // --- Lifecycle ---

    async start(): Promise<void> {
        log.info('Starting...');
        await this.pipeWire.cleanupOrphans();

        const pluginCount = await this.pluginLoader.load();
        log.info({ pluginCount }, 'Loaded plugins');

        this.apiServer = await createApiServer(this, this.config.apiPort ?? 3001);
        log.info({ port: this.config.apiPort ?? 3001 }, 'Local API listening');

        await this.lcpServer.start();
        log.info({ port: this.config.lcpPort ?? 8081 }, 'LCP Socket.IO listening');

        // Auto-connect to manager if a profile is active
        const active = this.profileStore.getActive();
        if (active) {
            log.info({ profile: active.name }, 'Auto-connecting to manager');
            this.managerConnection.connect(active);
        }

        this._running = true;
        this.lcpServer.broadcastEngineRunning(true);
        log.info('Started');
    }

    async stop(): Promise<void> {
        this.systemStats.stop();
        await this.lifecycle.stopAll();
        await this.processManager.killAll();
        this.managerConnection.disconnect();
        this.managerConnection.removeAllListeners();
        this.moduleManager.removeAllListeners();
        if (this.apiServer) {
            await this.apiServer.close();
            this.apiServer = null;
        }
        this._running = false;
        this.lcpControlHandler?.destroy();
        this.lcpServer.broadcastEngineRunning(false);
        await this.lcpServer.stop();
        this.lcpServer.removeAllListeners();
        this.logForwarder.destroy();
        log.info('Stopped');
    }

    /** Start all modules from current config. Public for API server. */
    async startModules(): Promise<void> {
        return this.lifecycle.startAll();
    }

    /** Stop all modules. Public for API server. */
    async stopModules(): Promise<void> {
        return this.lifecycle.stopAll();
    }

    /** Full reset: stop modules, restart PipeWire, restart modules. */
    async resetEngine(): Promise<void> {
        log.info('Resetting engine...');

        // 1. Stop all modules and clean up
        await this.lifecycle.stopAll();

        // 2. Try to restart PipeWire
        try {
            const { execFileSync } = await import('child_process');
            execFileSync('systemctl', ['--user', 'restart', 'pipewire'], { timeout: 10000 });
            log.info('PipeWire restarted successfully');
            // Wait for PipeWire to come back up
            await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
            log.warn({ err: formatError(err) },
                'Could not restart PipeWire (permission denied or not available) — continuing with cleanup');
        }

        // 3. Clean up any orphan PipeWire modules
        await this.pipeWire.cleanupOrphans();

        // 4. Restart modules
        await this.lifecycle.startAll();
        log.info('Engine reset complete');
    }

    async reconnectManager(): Promise<void> {
        this.managerConnection.disconnect();
        const active = this.profileStore.getActive();
        if (active) {
            this.managerConnection.connect(active);
        }
    }

    /** Enrich config modules with lcpType from plugin manifests. */
    private enrichConfigForLcp(config: Record<string, unknown>): Record<string, unknown> {
        const modules = config.modules as Record<string, Record<string, unknown>> | undefined;
        if (!modules) return config;
        const enriched: Record<string, unknown> = {};
        for (const [id, mod] of Object.entries(modules)) {
            const pluginId = mod.pluginId as string;
            const lcpType = this.pluginLoader.get(pluginId)?.manifest?.lcpType;
            enriched[id] = { ...mod, lcpType: lcpType ?? undefined };
        }
        return { ...config, modules: enriched };
    }

    /** Build combined init payload for LCP clients (config + runtime state + lcpType + engineRunning). */
    private getLcpInitData(): Record<string, unknown> {
        const config = this.enrichConfigForLcp(this.currentConfig ?? {});
        // Also merge runtime state into modules
        const modules = config.modules as Record<string, Record<string, unknown>> | undefined;
        if (modules) {
            for (const [id, mod] of Object.entries(modules)) {
                const instance = this.moduleManager.get(id);
                if (instance) {
                    Object.assign(mod, instance.getState());
                }
            }
        }
        return {
            engineRunning: this._running,
            ip: this.deviceIps[0] ?? '127.0.0.1',
            ips: this.deviceIps,
            hostname: this.deviceHostname,
            buildNumber: this.deviceBuildNumber,
            config,
        };
    }

}

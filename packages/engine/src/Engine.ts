import type { FastifyInstance } from 'fastify';
import { createLogger, formatError } from '@media-router/shared-types';

import { PluginLoader } from './plugins/PluginLoader.js';
import { ModuleManager } from './modules/ModuleManager.js';
import { MediaRouter } from './routing/MediaRouter.js';
import { ManagerConnection } from './comms/ManagerConnection.js';
import { LcpServer } from './comms/LcpServer.js';
import { ProfileStore } from './api/ProfileStore.js';
import { PipeWireManager } from './audio/PipeWireManager.js';
import { requirePwLink } from './audio/PwLinkOps.js';
import { ProcessManager } from './child-process/ProcessManager.js';
import { PaCommandQueue } from './audio/PaCommandQueue.js';
import { createApiServer } from './api/server.js';
import { LogForwarder } from './logging/LogForwarder.js';
import { CommandDispatcher } from './commands/CommandDispatcher.js';
import { EnginePatchRouter } from './EnginePatchRouter.js';
import { SystemStatsCollector } from './system/SystemStatsCollector.js';
import { DeviceProviderRegistry } from './system/DeviceProviderRegistry.js';
import { wireEngineEvents } from './EngineEventWiring.js';
import { getAllIps, findBuildNumber, getHostname } from './system/deviceInfo.js';
import { ModuleLifecycle } from './modules/ModuleLifecycle.js';
import { ModuleRunController } from './modules/ModuleRunController.js';

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
    readonly deviceProviders: DeviceProviderRegistry;

    private apiServer: FastifyInstance | null = null;
    private config: EngineConfig;
    private _running = false;
    private logForwarder: LogForwarder;
    private commandDispatcher: CommandDispatcher;
    private systemStats: SystemStatsCollector;
    private lifecycle: ModuleLifecycle;
    /** Single source of truth for module run state — see ModuleRunController. */
    readonly runController: ModuleRunController;

    /** Last config received from manager. */
    private currentConfig: Record<string, unknown> | null = null;
    private enginePatchRouter: EnginePatchRouter | null = null;
    /** Cached device info — computed once at construction. */
    private readonly deviceIps = getAllIps();
    private readonly deviceHostname = getHostname();
    private readonly deviceBuildNumber = findBuildNumber() || undefined;

    get running(): boolean {
        return this._running;
    }

    constructor(config: EngineConfig = {}) {
        this.config = config;
        const engine = this;

        this.logForwarder = new LogForwarder();

        // Audio subsystem
        this.paQueue = new PaCommandQueue();
        this.pipeWire = new PipeWireManager(this.paQueue);
        this.processManager = new ProcessManager();
        this.deviceProviders = new DeviceProviderRegistry();

        this.pluginLoader = new PluginLoader(config.pluginsDir);
        this.mediaRouter = new MediaRouter();
        this.moduleManager = new ModuleManager(
            this.pluginLoader,
            this.pipeWire,
            this.mediaRouter,
            this.processManager,
            this.deviceProviders,
        );
        this.managerConnection = new ManagerConnection();
        this.lcpServer = new LcpServer(config.lcpPort ?? 8081);
        this.lcpServer._getInitData = () => this.getLcpInitData();
        this.profileStore = new ProfileStore(config.profilesPath);

        this.mediaRouter.setDependencies(
            this.pipeWire,
            (id) => this.moduleManager.get(id),
            (id) => {
                const modules = (this.currentConfig?.modules ?? {}) as Record<
                    string,
                    Record<string, unknown>
                >;
                return (modules[id]?.displayName as string) ?? id;
            },
        );

        // Command dispatcher
        this.commandDispatcher = new CommandDispatcher({
            moduleManager: this.moduleManager,
            mediaRouter: this.mediaRouter,
            lcpServer: this.lcpServer,
            get currentConfig() {
                return engine.currentConfig;
            },
            startModules: () => this.startModules(),
            stopModules: () => this.stopModules(),
            resetEngine: () => this.resetEngine(),
            restartModule: (id) => this.lifecycle.restart(id),
            startSingleModule: (id) => this.lifecycle.startSingle(id),
            deleteSingleModule: (id) => this.lifecycle.deleteSingle(id),
            disableModule: (id) => this.lifecycle.disable(id),
            enableModule: (id) => this.lifecycle.enable(id),
        });

        // Module lifecycle
        this.lifecycle = new ModuleLifecycle(
            this.moduleManager,
            this.mediaRouter,
            this.pipeWire,
            () => this.currentConfig,
            this.pluginLoader,
        );

        // When a module generates dynamic ports, push as patch to manager + LCP
        this.lifecycle.onDynamicPortsResolved = (moduleId, ports) => {
            log.info(
                { moduleId, portCount: ports.length },
                'Dynamic ports resolved — pushing to manager',
            );
            const ops = [
                { op: 'replace' as const, path: `/modules/${moduleId}/ports`, value: ports },
            ];
            this.managerConnection.send('patch', { ops });
            this.lcpServer.broadcastConfigUpdate(ops);
        };

        // Single source of truth for module run state.
        this.runController = new ModuleRunController(this.lifecycle, (running) =>
            this.lcpServer.broadcastEngineRunning(running),
        );

        // System stats
        this.systemStats = new SystemStatsCollector((stats) => {
            stats.processCount =
                this.moduleManager.gstProcessCount + this.processManager.activeCount;
            this.managerConnection.send('system', stats);
        });

        // Unified patch router (N-1)
        this.enginePatchRouter = new EnginePatchRouter(
            this.moduleManager,
            this.mediaRouter,
            this.lcpServer,
            this.managerConnection,
            this.lifecycle,
            () => this.currentConfig,
            () => this.runController.isRunning,
        );

        wireEngineEvents({
            logForwarder: this.logForwarder,
            moduleManager: this.moduleManager,
            managerConnection: this.managerConnection,
            lcpServer: this.lcpServer,
            pipeWire: this.pipeWire,
            deviceProviders: this.deviceProviders,
            commandDispatcher: this.commandDispatcher,
            enginePatchRouter: this.enginePatchRouter,
            systemStats: this.systemStats,
            runController: this.runController,
            getCurrentConfig: () => this.currentConfig,
            setCurrentConfig: (config) => {
                this.currentConfig = config;
            },
            enrichConfigForLcp: (config) => this.enrichConfigForLcp(config),
        });
    }

    // --- Lifecycle ---

    async start(): Promise<void> {
        log.info('Starting...');
        await requirePwLink();
        await this.pipeWire.cleanupOrphans();

        const pluginCount = await this.pluginLoader.load({
            pipeWire: this.pipeWire,
            mediaRouter: this.mediaRouter,
            processManager: this.processManager,
            deviceProviders: this.deviceProviders,
        });
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
        this.enginePatchRouter?.destroy();
        this.lcpServer.broadcastEngineRunning(false);
        await this.lcpServer.stop();
        this.lcpServer.removeAllListeners();
        this.logForwarder.destroy();
        log.info('Stopped');
    }

    /** Public start (used by API server) — delegates to the run controller. */
    async startModules(): Promise<void> {
        return this.runController.start();
    }

    /** Public stop (used by API server) — delegates to the run controller. */
    async stopModules(): Promise<void> {
        return this.runController.stop();
    }

    /** Full reset: stop modules, restart PipeWire, restart modules. */
    async resetEngine(): Promise<void> {
        const wasRunning = this.runController.isRunning;
        log.info({ wasRunning }, 'Resetting engine...');

        // 1. Stop all modules and clean up
        await this.lifecycle.stopAll();

        // 2. Try to restart PipeWire (async to avoid blocking event loop)
        try {
            const { execFile } = await import('child_process');
            await new Promise<void>((resolve, reject) => {
                execFile(
                    'systemctl',
                    ['--user', 'restart', 'pipewire'],
                    { timeout: 10000 },
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    },
                );
            });
            log.info('PipeWire restarted successfully');
            // Wait for PipeWire to stabilise (Pi can be slow)
            await new Promise((r) => setTimeout(r, 3000));
        } catch (err) {
            log.warn(
                { err: formatError(err) },
                'Could not restart PipeWire (permission denied or not available) — continuing with cleanup',
            );
        }

        // 3. Clean up any orphan PipeWire modules
        await this.pipeWire.cleanupOrphans();

        // 4. Only restart modules if they were running before AND no stop was requested during reset
        if (wasRunning && !this.commandDispatcher.isStopRequested) {
            await this.lifecycle.startAll();
        } else if (this.commandDispatcher.isStopRequested) {
            log.info('Stop requested during reset — skipping module restart');
        }
        log.info({ wasRunning }, 'Engine reset complete');
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

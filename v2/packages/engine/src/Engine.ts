import type { FastifyInstance } from 'fastify';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';

import { PluginLoader } from './plugins/PluginLoader.js';
import { ModuleManager } from './modules/ModuleManager.js';
import { MediaRouter } from './routing/MediaRouter.js';
import { ManagerConnection } from './comms/ManagerConnection.js';
import { LcpServer } from './comms/LcpServer.js';
import { ProfileStore } from './api/ProfileStore.js';
import { PipeWireManager } from './audio/PipeWireManager.js';
import { PaCommandQueue } from './audio/PaCommandQueue.js';
import { createApiServer } from './api/server.js';
import { LogForwarder } from './logging/LogForwarder.js';
import { CommandDispatcher } from './commands/CommandDispatcher.js';
import { SystemStatsCollector } from './system/SystemStatsCollector.js';
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

    get running(): boolean {
        return this._running;
    }

    constructor(config: EngineConfig = {}) {
        this.config = config;

        this.logForwarder = new LogForwarder();

        // Audio subsystem
        this.paQueue = new PaCommandQueue();
        this.pipeWire = new PipeWireManager(this.paQueue);

        this.pluginLoader = new PluginLoader(config.pluginsDir);
        this.mediaRouter = new MediaRouter();
        this.moduleManager = new ModuleManager(this.pluginLoader, this.pipeWire, this.mediaRouter);
        this.managerConnection = new ManagerConnection();
        this.lcpServer = new LcpServer(config.lcpPort ?? 8081);
        this.profileStore = new ProfileStore(config.profilesPath);

        this.mediaRouter.setDependencies(this.pipeWire, (id) => this.moduleManager.get(id));

        // Command dispatcher
        this.commandDispatcher = new CommandDispatcher({
            moduleManager: this.moduleManager,
            mediaRouter: this.mediaRouter,
            lcpServer: this.lcpServer,
            startModules: () => this.lifecycle.startAll(),
            stopModules: () => this.lifecycle.stopAll(),
            restartModule: (id) => this.lifecycle.restart(id),
            disableModule: (id) => this.lifecycle.disable(id),
            enableModule: (id) => this.lifecycle.enable(id),
        });

        // Module lifecycle
        this.lifecycle = new ModuleLifecycle(
            this.moduleManager, this.mediaRouter, this.pipeWire,
            () => this.currentConfig,
        );

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
            }
        });

        this.managerConnection.on('config', (config: unknown) => {
            log.info('Received config from manager');
            this.currentConfig = config as Record<string, unknown>;
            this.lcpServer.broadcastConfigUpdate([{ op: 'replace', path: '/', value: config }]);
        });

        this.managerConnection.on('command', (command: unknown) => {
            this.commandDispatcher.dispatch(command as Record<string, unknown>);
        });

        this.lcpServer.on('control', (command: unknown) => {
            log.info({ command }, 'Received control from LCP');
            this.managerConnection.send('control', command);
        });

        this.lcpServer.on('configRequested', (socketId: string) => {
            if (this.currentConfig) {
                this.lcpServer.sendConfigToSocket(socketId, this.currentConfig);
            }
        });

        this.managerConnection.on('connected', () => {
            this.systemStats.start();
            const states = this.moduleManager.getAllStates();
            if (Object.keys(states).length > 0) {
                this.managerConnection.sendState(states);
            }
        });
        this.managerConnection.on('disconnected', () => {
            this.systemStats.stop();
        });
    }

    // --- Lifecycle ---

    async start(): Promise<void> {
        log.info('Starting...');
        await this.pipeWire.cleanupOrphans();

        const pluginCount = this.pluginLoader.load();
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
        log.info('Started');
    }

    async stop(): Promise<void> {
        this.systemStats.stop();
        await this.lifecycle.stopAll();
        this.managerConnection.disconnect();
        this.managerConnection.removeAllListeners();
        this.moduleManager.removeAllListeners();
        if (this.apiServer) {
            await this.apiServer.close();
            this.apiServer = null;
        }
        await this.lcpServer.stop();
        this.lcpServer.removeAllListeners();
        this.logForwarder.destroy();
        this._running = false;
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

    async reconnectManager(): Promise<void> {
        this.managerConnection.disconnect();
        const active = this.profileStore.getActive();
        if (active) {
            this.managerConnection.connect(active);
        }
    }
}

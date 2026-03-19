import type { FastifyInstance } from 'fastify';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('Engine');
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

export interface EngineConfig {
    /** Local API port (default 3001). */
    apiPort?: number;
    /** LCP Socket.IO port (default 8081). */
    lcpPort?: number;
    /** Path to plugins directory. */
    pluginsDir?: string;
    /** Path to profiles JSON file. */
    profilesPath?: string;
}

/**
 * Main engine orchestrator.
 *
 * Creates and wires together: PluginLoader, ModuleManager, MediaRouter,
 * PipeWireManager, ManagerConnection, LcpServer, and the Local API.
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
    private systemStatsTimer: ReturnType<typeof setInterval> | null = null;
    private logForwarder: LogForwarder;

    get running(): boolean {
        return this._running;
    }

    constructor(config: EngineConfig = {}) {
        this.config = config;

        // Log forwarding — must be created early to capture all logs
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

        // Wire MediaRouter to ModuleManager for connection execution
        this.mediaRouter.setDependencies(
            this.pipeWire,
            (id) => this.moduleManager.get(id),
        );

        this.wireEvents();
    }

    /** Last config received from manager — used when start command arrives. */
    private currentConfig: Record<string, unknown> | null = null;
    /** Mutex to prevent start/stop from overlapping. */
    private commandLock: Promise<void> = Promise.resolve();

    /**
     * Wire events between subsystems.
     */
    private wireEvents(): void {
        // Log forwarding → send batches to manager
        this.logForwarder.on('logs', (batch: unknown[]) => {
            if (this.managerConnection.isConnected) {
                this.managerConnection.send('logs', batch);
            }
        });

        // Module state changes → forward to manager + LCP
        this.moduleManager.on('stateChange', (instanceId: string, state: ModuleRuntimeState) => {
            this.managerConnection.sendState({ [instanceId]: state });
            this.lcpServer.broadcastState(instanceId, state);
        });

        // Auto-detected config changes (e.g. device channels) → push back to manager
        this.moduleManager.on('configUpdated', (instanceId: string, changes: Record<string, unknown>) => {
            log.trace({ instanceId, changes }, 'Plugin auto-detected config');
            this.managerConnection.send('configUpdated', { instanceId, changes });
        });

        // VU data → forward to manager (only on change, with 1s heartbeat)
        const lastVu = new Map<string, string>();
        const lastVuSent = new Map<string, number>();
        const VU_HEARTBEAT_MS = 1000;

        this.moduleManager.on('vuData', (instanceId: string, data: number[]) => {
            const key = JSON.stringify(data);
            const prev = lastVu.get(instanceId);
            const lastSent = lastVuSent.get(instanceId) ?? 0;
            const now = Date.now();

            // Send if data changed OR heartbeat interval elapsed
            if (key !== prev || now - lastSent >= VU_HEARTBEAT_MS) {
                lastVu.set(instanceId, key);
                lastVuSent.set(instanceId, now);
                this.managerConnection.sendVu(instanceId, data);
            }
        });

        // Manager sends config → store it (applied on start command) + notify LCP clients
        this.managerConnection.on('config', (config: unknown) => {
            log.info('Received config from manager');
            this.currentConfig = config as Record<string, unknown>;
            this.lcpServer.broadcastConfigUpdate([
                { op: 'replace', path: '/', value: config },
            ]);
        });

        // Manager sends command → handle start/stop/moduleConfig
        this.managerConnection.on('command', (command: unknown) => {
            const cmd = command as Record<string, unknown>;
            log.info({ command: cmd.command }, 'Received command');

            switch (cmd.command) {
                case 'start':
                    this.commandLock = this.commandLock
                        .then(() => this.startModules())
                        .catch((err) => log.error({ err }, 'Start failed'));
                    break;
                case 'stop':
                    this.commandLock = this.commandLock
                        .then(() => this.stopModules())
                        .catch((err) => log.error({ err }, 'Stop failed'));
                    break;
                case 'moduleConfig': {
                    const moduleId = cmd.moduleId as string;
                    const changes = cmd.changes as Record<string, unknown>;
                    if (!this.moduleManager.get(moduleId)) {
                        log.warn({ moduleId }, 'moduleConfig: module not running');
                        break;
                    }
                    this.moduleManager.applyConfigUpdate(moduleId, changes).catch((err) =>
                        log.error({ err, moduleId }, 'Config update failed'),
                    );
                    // Notify LCP clients of setting changes
                    for (const [key, value] of Object.entries(changes)) {
                        this.lcpServer.broadcastConfigUpdate([
                            { op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value },
                        ]);
                    }
                    break;
                }
                case 'moduleDisable': {
                    const moduleId = cmd.moduleId as string;
                    this.disableModule(moduleId).catch((err) => log.error({ err, moduleId }, 'Module disable failed'));
                    this.lcpServer.broadcastConfigUpdate([
                        { op: 'replace', path: `/modules/${moduleId}/enabled`, value: false },
                    ]);
                    break;
                }
                case 'moduleEnable': {
                    const moduleId = cmd.moduleId as string;
                    this.enableModule(moduleId).catch((err) => log.error({ err, moduleId }, 'Module enable failed'));
                    this.lcpServer.broadcastConfigUpdate([
                        { op: 'replace', path: `/modules/${moduleId}/enabled`, value: true },
                    ]);
                    break;
                }
                case 'moduleRestart': {
                    const moduleId = cmd.moduleId as string;
                    if (!this.moduleManager.get(moduleId)) {
                        log.warn({ moduleId }, 'moduleRestart: module not running');
                        break;
                    }
                    this.restartModule(moduleId).catch((err) => log.error({ err, moduleId }, 'Module restart failed'));
                    break;
                }
                case 'routingConnect': {
                    const { sourceModuleId, sourcePortId, sinkModuleId, sinkPortId } = cmd as Record<string, string>;
                    this.mediaRouter.createConnection(sourceModuleId, sourcePortId, sinkModuleId, sinkPortId)
                        .then((connId) => {
                            log.info({ connectionId: connId }, 'Live connect');
                            this.lcpServer.broadcastConfigUpdate([
                                { op: 'add', path: '/connections/-', value: { id: connId, sourceModuleId, sourcePortId, sinkModuleId, sinkPortId } },
                            ]);
                        })
                        .catch((err) => log.error({ err }, 'Live connect failed'));
                    break;
                }
                case 'routingDisconnect': {
                    const connectionId = cmd.connectionId as string;
                    this.mediaRouter.removeConnection(connectionId)
                        .then(() => {
                            log.info({ connectionId }, 'Live disconnect');
                            this.lcpServer.broadcastConfigUpdate([
                                { op: 'remove', path: `/connections/${connectionId}` },
                            ]);
                        })
                        .catch((err) => log.error({ err, connectionId }, 'Live disconnect failed'));
                    break;
                }
            }
        });

        // LCP sends control → forward to module manager + manager
        this.lcpServer.on('control', (command: unknown) => {
            log.info({ command }, 'Received control from LCP');
            this.managerConnection.send('control', command);
        });

        // LCP client requests full config (initial sync)
        this.lcpServer.on('configRequested', (socketId: string) => {
            if (this.currentConfig) {
                this.lcpServer.sendConfigToSocket(socketId, this.currentConfig);
            }
        });

        // System stats: start on connect, stop on disconnect
        // Also send current module states so the UI has accurate health/running on page refresh
        this.managerConnection.on('connected', () => {
            this.startSystemStats();
            const states = this.moduleManager.getAllStates();
            if (Object.keys(states).length > 0) {
                this.managerConnection.sendState(states);
            }
        });
        this.managerConnection.on('disconnected', () => {
            this.stopSystemStats();
        });
    }

    /**
     * Start the engine.
     */
    async start(): Promise<void> {
        log.info('Starting...');

        // 1. Clean up orphan PipeWire modules from previous runs
        await this.pipeWire.cleanupOrphans();

        // 2. Discover plugins
        const pluginCount = this.pluginLoader.load();
        log.info({ pluginCount }, 'Loaded plugins');

        // 3. Start Local API
        this.apiServer = await createApiServer(this, this.config.apiPort ?? 3001);

        // 4. Start LCP Socket.IO
        await this.lcpServer.start();

        // 5. Auto-connect to manager if active profile exists
        const activeProfile = this.profileStore.getActive();
        if (activeProfile) {
            log.info({ profile: activeProfile.name }, 'Auto-connecting to manager');
            this.managerConnection.connect(activeProfile);
        } else {
            log.info('No active profile — not connecting to manager');
        }

        this._running = true;
        log.info('Started');
    }

    /**
     * Collect and send CPU%, memory%, CPU temp every 5 seconds.
     */
    private startSystemStats(): void {
        if (this.systemStatsTimer) return;

        let prevCpuTotal = 0;
        let prevCpuIdle = 0;

        this.systemStatsTimer = setInterval(() => {
            try {
                const os = require('os');
                const fs = require('fs');

                // CPU usage (delta since last sample)
                const cpus = os.cpus();
                let totalTick = 0;
                let idleTick = 0;
                for (const cpu of cpus) {
                    for (const type of Object.values(cpu.times) as number[]) totalTick += type;
                    idleTick += cpu.times.idle;
                }
                const totalDelta = totalTick - prevCpuTotal;
                const idleDelta = idleTick - prevCpuIdle;
                const cpuPercent = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0;
                prevCpuTotal = totalTick;
                prevCpuIdle = idleTick;

                // Memory usage
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

                // CPU temperature (Linux thermal zone)
                let cpuTemp: number | null = null;
                try {
                    const temp = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf-8');
                    cpuTemp = Math.round(parseInt(temp, 10) / 1000);
                } catch { /* not available */ }

                this.managerConnection.send('system', {
                    cpu: cpuPercent,
                    mem: memPercent,
                    temp: cpuTemp,
                });
            } catch { /* ignore */ }
        }, 2000);
    }

    private stopSystemStats(): void {
        if (this.systemStatsTimer) {
            clearInterval(this.systemStatsTimer);
            this.systemStatsTimer = null;
        }
    }

    /**
     * Start all modules from the current config, then apply connections.
     */
    async startModules(): Promise<void> {
        if (!this.currentConfig) {
            log.info('No config — nothing to start');
            return;
        }

        const modules = (this.currentConfig.modules ?? {}) as Record<string, Record<string, unknown>>;
        log.info({ count: Object.keys(modules).length }, 'Starting modules');

        // Phase 1: Create and start all modules
        for (const [instanceId, modConfig] of Object.entries(modules)) {
            const pluginId = modConfig.pluginId as string;
            if (!pluginId) continue;

            // Skip disabled modules
            if (modConfig.enabled === false) {
                log.info({ instanceId }, 'Module disabled, skipping');
                continue;
            }

            // Skip if already running
            if (this.moduleManager.get(instanceId)?.running) {
                log.info({ instanceId }, 'Module already running, skipping');
                continue;
            }

            try {
                if (!this.moduleManager.get(instanceId)) {
                    this.moduleManager.createModule(instanceId, pluginId, (modConfig.settings ?? {}) as Record<string, unknown>);
                    log.info({ instanceId, pluginId }, 'Created module');

                    // Register ports from manifest immediately — manager and routing
                    // need to know port layout before the module starts
                    const ports = (modConfig.ports ?? []) as Array<{ id: string; direction: string; streamType: string; label?: string }>;
                    if (ports.length > 0) {
                        this.mediaRouter.registerPorts(instanceId, ports.map((p) => ({
                            id: p.id,
                            direction: p.direction as 'input' | 'output',
                            streamType: p.streamType as any,
                            label: p.label ?? p.id,
                        })));
                    }
                }

                await this.moduleManager.startModule(instanceId);
                log.info({ instanceId }, 'Started module');
            } catch (err) {
                log.error({ err, instanceId }, 'Failed to start module');
            }
        }

        // Wait for PipeWire to settle before creating connections
        await new Promise((r) => setTimeout(r, 300));

        // Phase 2: Apply connections (after all modules are started)
        const connections = (this.currentConfig.connections ?? []) as Array<{
            id: string;
            sourceModuleId: string;
            sourcePortId: string;
            sinkModuleId: string;
            sinkPortId: string;
        }>;

        if (connections.length > 0) {
            log.info({ count: connections.length }, 'Applying connections');

            // Two passes: MPEG-TS first (may start decoders), then audio
            const mpegtsConns = connections.filter((c: any) => {
                const port = this.mediaRouter.getPort(c.sourceModuleId, c.sourcePortId);
                return port?.streamType === 'muxed/mpegts';
            });
            const audioConns = connections.filter((c: any) => {
                const port = this.mediaRouter.getPort(c.sourceModuleId, c.sourcePortId);
                return port?.streamType !== 'muxed/mpegts';
            });

            // Apply MPEG-TS connections first
            for (const conn of mpegtsConns) {
                const src = this.moduleManager.get(conn.sourceModuleId);
                const sink = this.moduleManager.get(conn.sinkModuleId);
                if (!src?.running || !sink?.running) {
                    // Decoder idle — MPEG-TS connection will start it
                }
                try {
                    await this.mediaRouter.createConnection(
                        conn.sourceModuleId, conn.sourcePortId,
                        conn.sinkModuleId, conn.sinkPortId,
                    );
                    log.info({ source: `${conn.sourceModuleId}:${conn.sourcePortId}`, sink: `${conn.sinkModuleId}:${conn.sinkPortId}` }, 'Connected');
                } catch (err) {
                    log.error({ err, connectionId: conn.id }, 'Failed to connect');
                }
            }

            // Wait for decoder pipelines to start before applying audio connections
            if (mpegtsConns.length > 0 && audioConns.length > 0) {
                await new Promise((r) => setTimeout(r, 500));
            }

            // Apply audio connections
            for (const conn of audioConns) {
                // Only connect if both endpoints are running (or enabled — audio output is always running)
                const src = this.moduleManager.get(conn.sourceModuleId);
                const sink = this.moduleManager.get(conn.sinkModuleId);
                if (!src?.running || !sink?.running) {
                    log.info({ connectionId: conn.id }, 'Skipping connection — endpoint not running');
                    continue;
                }
                try {
                    await this.mediaRouter.createConnection(
                        conn.sourceModuleId,
                        conn.sourcePortId,
                        conn.sinkModuleId,
                        conn.sinkPortId,
                    );
                    log.info({ source: `${conn.sourceModuleId}:${conn.sourcePortId}`, sink: `${conn.sinkModuleId}:${conn.sinkPortId}` }, 'Connected');
                } catch (err) {
                    log.error({ err, connectionId: conn.id }, 'Failed to connect');
                }
            }
        }
    }

    /**
     * Stop all running modules and remove all connections.
     */
    async stopModules(): Promise<void> {
        log.info('Stopping all modules');

        // 1. Remove all connections (skip module restarts — we're stopping everything)
        await this.mediaRouter.removeAllConnections(true);

        // 2. Stop all modules in parallel
        await this.moduleManager.stopAll();

        // 3. Cleanup orphan PipeWire modules
        await this.pipeWire.cleanupOrphans();

        log.info('All modules stopped');
    }

    /**
     * Restart a single module, re-applying its connections.
     */
    private async restartModule(moduleId: string): Promise<void> {
        // 1. Tear down connections involving this module
        // skipModuleRestart=true: don't restart encoder/decoder — we're about to restart them
        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        // 2. Restart the module
        await this.moduleManager.stopModule(moduleId);
        await this.moduleManager.startModule(moduleId);

        // 3. Re-apply connections
        for (const conn of connections) {
            try {
                await this.mediaRouter.createConnection(
                    conn.sourceModuleId,
                    conn.sourcePortId,
                    conn.sinkModuleId,
                    conn.sinkPortId,
                );
            } catch (err) {
                log.error({ err, connectionId: conn.id }, 'Failed to re-connect after restart');
            }
        }
    }

    /**
     * Disable a module: tear down its connections and stop it.
     */
    private async disableModule(moduleId: string): Promise<void> {
        const mod = this.moduleManager.get(moduleId);
        if (!mod?.running) {
            log.info({ moduleId }, 'Module already stopped');
            return;
        }

        // Tear down connections involving this module
        // skipModuleRestart=true: don't restart encoder/decoder — we're about to stop them
        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        await this.moduleManager.stopModule(moduleId);

        // Release encoder port if this was an encoder
        this.mediaRouter.releaseEncoderPort(moduleId);

        log.info({ moduleId }, 'Module disabled');
    }

    /**
     * Enable a module: create/start it and re-establish its connections.
     */
    private async enableModule(moduleId: string): Promise<void> {
        // Create module if it doesn't exist yet
        if (!this.moduleManager.get(moduleId) && this.currentConfig) {
            const modules = (this.currentConfig.modules ?? {}) as Record<string, Record<string, unknown>>;
            const modConfig = modules[moduleId];
            if (modConfig) {
                this.moduleManager.createModule(moduleId, modConfig.pluginId as string, (modConfig.settings ?? {}) as Record<string, unknown>);
            }
        }

        const mod = this.moduleManager.get(moduleId);
        if (!mod) {
            log.warn({ moduleId }, 'Cannot enable — module not found in config');
            return;
        }

        if (mod.running) {
            log.info({ moduleId }, 'Module already running');
            return;
        }

        await this.moduleManager.startModule(moduleId);

        // Register ports
        if (this.currentConfig) {
            const modules = (this.currentConfig.modules ?? {}) as Record<string, Record<string, unknown>>;
            const modConfig = modules[moduleId];
            if (modConfig?.ports) {
                const ports = modConfig.ports as Array<{ id: string; direction: string; streamType: string; label?: string }>;
                this.mediaRouter.registerPorts(moduleId, ports.map((p) => ({
                    id: p.id,
                    direction: p.direction as 'input' | 'output',
                    streamType: p.streamType as any,
                    label: p.label ?? p.id,
                })));
            }
        }

        // Wait for PipeWire to settle
        await new Promise((r) => setTimeout(r, 300));

        // Re-apply connections involving this module (only if both endpoints running)
        if (this.currentConfig) {
            const connections = (this.currentConfig.connections ?? []) as Array<{
                sourceModuleId: string; sourcePortId: string;
                sinkModuleId: string; sinkPortId: string;
            }>;
            for (const conn of connections) {
                if (conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId) {
                    const src = this.moduleManager.get(conn.sourceModuleId);
                    const sink = this.moduleManager.get(conn.sinkModuleId);
                    if (src?.running && sink?.running) {
                        try {
                            await this.mediaRouter.createConnection(
                                conn.sourceModuleId, conn.sourcePortId,
                                conn.sinkModuleId, conn.sinkPortId,
                            );
                        } catch (err) {
                            log.error({ err }, 'Failed to connect after enable');
                        }
                    }
                }
            }
        }

        log.info({ moduleId }, 'Module enabled');
    }

    /**
     * Reconnect to manager (called when active profile changes).
     */
    async reconnectManager(): Promise<void> {
        this.managerConnection.disconnect();
        const profile = this.profileStore.getActive();
        if (profile) {
            log.info({ profile: profile.name }, 'Reconnecting to manager');
            this.managerConnection.connect(profile);
        }
    }

    /**
     * Graceful shutdown.
     */
    async stop(): Promise<void> {
        log.info('Shutting down');
        this.stopSystemStats();
        this.logForwarder.destroy();

        // Remove event listeners to prevent accumulation on restart
        this.moduleManager.removeAllListeners();
        this.managerConnection.removeAllListeners();
        this.lcpServer.removeAllListeners();

        // 1. Remove all connections
        await this.mediaRouter.removeAllConnections();

        // 2. Stop all modules
        await this.moduleManager.destroyAll();

        // 3. Cleanup PipeWire
        await this.pipeWire.cleanupOrphans();

        // 4. Disconnect from manager
        this.managerConnection.disconnect();

        // 5. Stop LCP server
        await this.lcpServer.stop();

        // 6. Stop API server
        if (this.apiServer) {
            await this.apiServer.close();
        }

        this._running = false;
        log.info('Shutdown complete');
    }
}

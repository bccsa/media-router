import express from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'http';
import { Server as SocketIOServer, type Socket as IOSocket } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { createLogger } from '@media-router/shared-types';
import { ConfigStore } from './config/ConfigStore.js';
import { EngineConnectionManager } from './engines/EngineConnectionManager.js';

const log = createLogger('Manager');

export interface ManagerConfig {
    httpPort?: number;
    dgramPort?: number;
    dbPath?: string;
}

const DEFAULT_CONFIG: ManagerConfig = {
    httpPort: 8080,
    dgramPort: 3000,
};

/**
 * Central manager — stores engine configs, manages engine connections,
 * serves Web UI and proxies state between engines and browsers.
 */
export class Manager {
    private config: ManagerConfig;
    private configStore: ConfigStore;
    private engineManager: EngineConnectionManager;
    private app: express.Application;
    private httpServer: HttpServer;
    private io: SocketIOServer;
    private running = false;
    /** Ring buffer of recent log entries per engine (max 1000 each). */
    private logBuffers = new Map<string, unknown[]>();
    /** Cached module runtime states per engine (health, running, error) — sent to new browser connections. */
    private cachedModuleStates = new Map<string, Record<string, unknown>>();
    private readonly LOG_BUFFER_MAX = 1000;

    constructor(config: Partial<ManagerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.configStore = new ConfigStore(this.config.dbPath);
        this.engineManager = new EngineConnectionManager(
            this.configStore,
            this.config.dgramPort,
        );

        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());
        this.httpServer = createServer(this.app);
        this.io = new SocketIOServer(this.httpServer, { cors: { origin: '*' } });

        this.setupEngineEventForwarding();
        this.setupSocketIO();
        this.setupHttpRoutes();
    }

    async start(): Promise<void> {
        if (this.running) return;
        await this.engineManager.start();
        log.info({ port: this.config.dgramPort }, 'dgram-comms listening');

        await new Promise<void>((resolve) => {
            this.httpServer.listen(this.config.httpPort, () => resolve());
        });
        this.running = true;
        log.info({ port: this.config.httpPort }, 'HTTP + Socket.IO listening');
    }

    async shutdown(): Promise<void> {
        if (!this.running) return;
        await this.engineManager.stop();
        this.io.close();
        await new Promise<void>((resolve) => {
            this.httpServer.close(() => resolve());
        });
        this.configStore.close();
        this.running = false;
        log.info('shutdown complete');
    }

    // --- Engine event forwarding → Socket.IO ---

    private setupEngineEventForwarding(): void {
        this.engineManager.on('engineOnline', (engineId: string) => {
            this.io.emit('engine:online', { engineId });

            // If engine was marked as running, auto-send start command on reconnect
            if (this.getEngineRunning(engineId)) {
                log.info({ engineId }, 'engine reconnected — auto-sending start');
                // Re-push config first
                const engine = this.configStore.getEngine(engineId);
                if (engine?.active_profile) {
                    const config = this.configStore.getProfile(engineId, engine.active_profile as string);
                    if (config) {
                        this.engineManager.sendToEngine(engineId, 'config', config, { guaranteeDelivery: true });
                    }
                }
                // Then send start
                setTimeout(() => {
                    this.engineManager.sendToEngine(engineId, 'command', { command: 'start' }, { guaranteeDelivery: true });
                }, 500);
            }
        });
        this.engineManager.on('engineOffline', (engineId: string) => {
            this.cachedModuleStates.delete(engineId);
            this.io.emit('engine:offline', { engineId });
        });
        this.engineManager.on('engineState', (engineId: string, state: unknown) => {
            // Cache runtime state so it's available for new browser connections
            this.cachedModuleStates.set(engineId, {
                ...(this.cachedModuleStates.get(engineId) ?? {}),
                ...(state as Record<string, unknown>),
            });
            this.io.emit('engine:state', { engineId, state });
        });
        this.engineManager.on('engineVu', (engineId: string, data: unknown) => {
            this.io.to(`watch:${engineId}`).volatile.emit('engine:vu', { engineId, ...(data as Record<string, unknown>) });
        });
        this.engineManager.on('engineSystem', (engineId: string, data: unknown) => {
            // System stats go to watchers AND globally (sidebar shows CPU/mem for all engines)
            this.io.volatile.emit('engine:system', { engineId, ...(data as Record<string, unknown>) });
        });

        // Auto-detected config from engine (e.g. device channels/sampleRate)
        this.engineManager.on('engineConfigUpdated', (engineId: string, data: unknown) => {
            const d = data as { instanceId: string; changes: Record<string, unknown> };
            if (!d?.instanceId || !d?.changes) return;

            // Update stored config in SQLite
            const engine = this.configStore.getEngine(engineId);
            if (engine?.active_profile) {
                const config = this.configStore.getProfile(engineId, engine.active_profile as string) ?? {};
                const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
                const mod = modules[d.instanceId];
                if (mod) {
                    const settings = (mod.settings ?? {}) as Record<string, unknown>;
                    Object.assign(settings, d.changes);
                    mod.settings = settings;
                    this.configStore.updateProfileConfig(engineId, engine.active_profile as string, config);
                }
            }

            // Broadcast to browsers — patch the module's settings
            const patches = Object.entries(d.changes).map(([key, value]) => ({
                op: 'replace' as const,
                path: `/modules/${d.instanceId}/settings/${key}`,
                value,
            }));
            this.io.emit('engine:update', { engineId, patch: patches });
        });

        this.engineManager.on('engineLogs', (engineId: string, batch: unknown) => {
            if (!Array.isArray(batch)) return;

            // Store in ring buffer
            let buffer = this.logBuffers.get(engineId);
            if (!buffer) {
                buffer = [];
                this.logBuffers.set(engineId, buffer);
            }
            buffer.push(...batch);
            // Trim to max size
            if (buffer.length > this.LOG_BUFFER_MAX) {
                buffer.splice(0, buffer.length - this.LOG_BUFFER_MAX);
            }

            // Stream only to watchers of this engine
            this.io.to(`watch:${engineId}`).volatile.emit('engine:logs', { engineId, entries: batch });
        });
    }

    // --- Socket.IO handlers (browser ↔ manager) ---

    private setupSocketIO(): void {
        this.io.on('connection', (socket: IOSocket) => {
            log.info({ socketId: socket.id }, 'browser connected');

            // Send full state on connect — MUST include modules/connections from active profile
            const engines = this.configStore.getAllEngines();
            const pluginManifests = this.getAvailablePlugins();
            socket.emit(
                'engine:list',
                engines.map((e) => {
                    let modules: Record<string, unknown> = {};
                    let connections: unknown[] = [];

                    if (e.active_profile) {
                        const profileConfig = this.configStore.getProfile(
                            e.engine_id as string,
                            e.active_profile as string,
                        );
                        if (profileConfig) {
                            modules = (profileConfig.modules ?? {}) as Record<string, unknown>;
                            connections = (profileConfig.connections ?? []) as unknown[];
                        }
                    }

                    // Overlay live plugin manifest (ports, configSchema) on stored modules
                    const cachedStates = this.cachedModuleStates.get(e.engine_id as string) ?? {};
                    for (const [id, mod] of Object.entries(modules)) {
                        const m = mod as Record<string, unknown>;
                        const manifest = pluginManifests.find((p) => p.pluginId === m.pluginId);
                        if (manifest) {
                            m.ports = manifest.ports ?? [];
                            m.configSchema = manifest.configSchema ?? {};
                            m.color = manifest.color;
                            m.icon = manifest.icon;
                            m.statusSections = manifest.statusSections;
                        }
                        // Overlay cached runtime state (health, running, error) if available
                        const cached = cachedStates[id] as Record<string, unknown> | undefined;
                        if (cached) {
                            if ('health' in cached) m.health = cached.health;
                            if ('running' in cached) m.running = cached.running;
                            if ('error' in cached) m.error = cached.error;
                            if ('statusData' in cached) m.statusData = cached.statusData;
                        }
                    }

                    return {
                        ...e,
                        online: this.engineManager.isEngineOnline(e.engine_id as string),
                        running: this.getEngineRunning(e.engine_id as string),
                        modules,
                        connections,
                    };
                }),
            );

            // --- Engine watch (only stream VU/logs/system for the active engine) ---
            socket.on('watch:engine', (payload: { engineId: string }) => {
                // Leave all previous watch rooms
                for (const room of socket.rooms) {
                    if (room.startsWith('watch:')) socket.leave(room);
                }
                if (payload.engineId) {
                    socket.join(`watch:${payload.engineId}`);
                }
            });

            // --- Log history request ---
            socket.on('logs:history', (payload: { engineId: string }, callback?: (entries: unknown[]) => void) => {
                const buffer = this.logBuffers.get(payload.engineId) ?? [];
                if (typeof callback === 'function') {
                    callback(buffer);
                } else {
                    socket.emit('logs:history', { engineId: payload.engineId, entries: buffer });
                }
            });

            // --- Module management ---
            socket.on('module:add', (payload: any) => {
                if (!payload?.engineId || !payload?.pluginId || !payload?.displayName) return;
                this.handleModuleAdd(payload);
            });
            socket.on('module:delete', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId) return;
                this.handleModuleDelete(payload);
            });
            socket.on('module:position', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId || !payload?.position) return;
                this.handleModulePosition(payload);
            });
            socket.on('module:config', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId || !payload?.changes) return;
                this.handleModuleConfig(payload);
            });
            socket.on('module:toggle', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId) return;
                // Atomically toggle enabled state in profile config
                const engine = this.configStore.getEngine(payload.engineId);
                if (!engine?.active_profile) return;

                let newEnabled = true;
                this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
                    const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
                    if (modules[payload.moduleId]) {
                        const isEnabled = modules[payload.moduleId].enabled !== false;
                        newEnabled = !isEnabled;
                        modules[payload.moduleId].enabled = newEnabled;
                        config.modules = modules;
                    }
                    return config;
                });

                // Broadcast to browsers
                this.io.emit('engine:update', {
                    engineId: payload.engineId,
                    patch: [{
                        op: 'replace',
                        path: `/modules/${payload.moduleId}/enabled`,
                        value: newEnabled,
                    }],
                });

                // Forward to engine if online
                if (this.engineManager.isEngineOnline(payload.engineId)) {
                    this.engineManager.sendToEngine(payload.engineId, 'command', {
                        command: newEnabled ? 'moduleEnable' : 'moduleDisable',
                        moduleId: payload.moduleId,
                    }, { guaranteeDelivery: true });
                }
            });
            socket.on('module:restart', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId) return;
                if (this.engineManager.isEngineOnline(payload.engineId)) {
                    this.engineManager.sendToEngine(payload.engineId, 'command', {
                        command: 'moduleRestart',
                        moduleId: payload.moduleId,
                    }, { guaranteeDelivery: true });
                }
            });

            // UI-only metadata (focused, etc.) — stored on module root, not forwarded to engine
            socket.on('module:meta', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId || !payload?.meta) return;
                const eng = this.configStore.getEngine(payload.engineId);
                if (!eng?.active_profile) return;
                this.configStore.modifyProfileConfig(payload.engineId, eng.active_profile as string, (config) => {
                    const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
                    if (modules[payload.moduleId]) {
                        Object.assign(modules[payload.moduleId], payload.meta);
                    }
                    return config;
                });
                // Broadcast to all browsers
                const patchOps = Object.entries(payload.meta as Record<string, unknown>).map(([key, value]) => ({
                    op: 'replace',
                    path: `/modules/${payload.moduleId}/${key}`,
                    value,
                }));
                this.io.emit('engine:update', { engineId: payload.engineId, patch: patchOps });
            });

            socket.on('module:rename', (payload: any) => {
                if (!payload?.engineId || !payload?.moduleId || !payload?.displayName) return;
                const engine = this.configStore.getEngine(payload.engineId);
                if (!engine?.active_profile) return;
                this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
                    const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
                    if (modules[payload.moduleId]) {
                        modules[payload.moduleId].displayName = payload.displayName;
                        config.modules = modules;
                    }
                    return config;
                });
                this.io.emit('engine:update', {
                    engineId: payload.engineId,
                    patch: [{ op: 'replace', path: `/modules/${payload.moduleId}/displayName`, value: payload.displayName }],
                });
            });

            // --- Engine start/stop ---
            socket.on('engine:start', (payload: any) => {
                if (!payload?.engineId) return;
                this.setEngineRunning(payload.engineId, true);
                this.sendEngineCommand(payload.engineId, 'start');
                this.io.emit('engine:running', { engineId: payload.engineId, running: true });
            });
            socket.on('engine:stop', (payload: any) => {
                if (!payload?.engineId) return;
                this.setEngineRunning(payload.engineId, false);
                this.sendEngineCommand(payload.engineId, 'stop');
                this.io.emit('engine:running', { engineId: payload.engineId, running: false });
            });

            // --- Routing ---
            socket.on('routing:connect', (payload: any) => {
                if (!payload?.engineId || !payload?.sourceModuleId || !payload?.sourcePortId || !payload?.sinkModuleId || !payload?.sinkPortId) return;
                this.handleRoutingConnect(payload);
            });
            socket.on('routing:disconnect', (payload: any) => {
                if (!payload?.engineId || !payload?.connectionId) return;
                this.handleRoutingDisconnect(payload);
            });

            socket.on('disconnect', () => {
                log.info({ socketId: socket.id }, 'browser disconnected');
            });
        });
    }

    // --- Module handlers ---

    private handleModuleAdd(payload: {
        engineId: string;
        pluginId: string;
        displayName: string;
        position?: { x: number; y: number };
        settings?: Record<string, unknown>;
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine) return;

        // Ensure active profile exists
        let profileName = engine.active_profile as string | null;
        if (!profileName) {
            profileName = 'default';
            this.configStore.createProfile(payload.engineId, profileName, {});
            this.configStore.setActiveProfile(payload.engineId, profileName);
        }

        const instanceId = `${payload.pluginId}-${Date.now().toString(36)}`;

        // Look up plugin manifest for ports and configSchema
        const plugins = this.getAvailablePlugins();
        const pluginManifest = plugins.find((p) => p.pluginId === payload.pluginId);
        const ports = pluginManifest?.ports ?? [];
        const configSchema = pluginManifest?.configSchema ?? {};

        // Build default settings from configSchema
        const defaultSettings: Record<string, unknown> = {};
        const schemaProps = ((configSchema as any).properties ?? {}) as Record<
            string,
            Record<string, unknown>
        >;
        for (const [key, schemaProp] of Object.entries(schemaProps)) {
            if (schemaProp.default !== undefined) {
                defaultSettings[key] = schemaProp.default;
            }
        }
        const settings = { ...defaultSettings, ...(payload.settings ?? {}) };

        // Atomically store in profile config
        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, profileName, (config) => {
            const modules = (config.modules ?? {}) as Record<string, unknown>;
            modules[instanceId] = {
                pluginId: payload.pluginId,
                displayName: payload.displayName,
                position: payload.position ?? { x: 100, y: 100 },
                settings,
                ports,
                configSchema,
            };
            config.modules = modules;
            return config;
        });

        // Push to engine if online
        if (updatedConfig && this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'config', updatedConfig, {
                guaranteeDelivery: true,
            });
        }

        // Broadcast patch to all browsers
        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [
                {
                    op: 'add',
                    path: `/modules/${instanceId}`,
                    value: {
                        instanceId,
                        pluginId: payload.pluginId,
                        displayName: payload.displayName,
                        running: false,
                        health: 'stopped',
                        pendingRestart: false,
                        position: payload.position ?? { x: 100, y: 100 },
                        settings,
                        ports,
                        configSchema,
                        color: pluginManifest?.color,
                        icon: pluginManifest?.icon,
                        statusSections: pluginManifest?.statusSections,
                    },
                },
            ],
        });
    }

    private handleModuleDelete(payload: { engineId: string; moduleId: string }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, unknown>;
            delete modules[payload.moduleId];
            // Remove connections involving this module
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            config.connections = connections.filter(
                (c) => c.sourceModuleId !== payload.moduleId && c.sinkModuleId !== payload.moduleId,
            );
            config.modules = modules;
            return config;
        });

        if (updatedConfig && this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'config', updatedConfig, {
                guaranteeDelivery: true,
            });
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'remove', path: `/modules/${payload.moduleId}` }],
        });
    }

    private handleModulePosition(payload: {
        engineId: string;
        moduleId: string;
        position: { x: number; y: number };
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                modules[payload.moduleId].position = payload.position;
                config.modules = modules;
            }
            return config;
        });

        // Broadcast position change to all browser tabs
        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [
                { op: 'replace', path: `/modules/${payload.moduleId}/position`, value: payload.position },
            ],
        });
    }

    private handleModuleConfig(payload: {
        engineId: string;
        moduleId: string;
        changes: Record<string, unknown>;
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                const settings = (modules[payload.moduleId].settings ?? {}) as Record<string, unknown>;
                Object.assign(settings, payload.changes);
                modules[payload.moduleId].settings = settings;
                config.modules = modules;
            }
            return config;
        });

        // Forward to engine
        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'moduleConfig',
                moduleId: payload.moduleId,
                changes: payload.changes,
            }, { guaranteeDelivery: true });
        }

        // Broadcast updated settings to all browsers
        const patchOps = Object.entries(payload.changes).map(([key, value]) => ({
            op: 'replace' as const,
            path: `/modules/${payload.moduleId}/settings/${key}`,
            value,
        }));
        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: patchOps,
        });
    }

    // --- Routing handlers ---

    private handleRoutingConnect(payload: {
        engineId: string;
        sourceModuleId: string;
        sourcePortId: string;
        sinkModuleId: string;
        sinkPortId: string;
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const connId = `${payload.sourceModuleId}:${payload.sourcePortId}-${payload.sinkModuleId}:${payload.sinkPortId}`;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            connections.push({
                id: connId,
                sourceModuleId: payload.sourceModuleId,
                sourcePortId: payload.sourcePortId,
                sinkModuleId: payload.sinkModuleId,
                sinkPortId: payload.sinkPortId,
            });
            config.connections = connections;
            return config;
        });

        // Send live connect command to engine (applies immediately)
        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'routingConnect',
                sourceModuleId: payload.sourceModuleId,
                sourcePortId: payload.sourcePortId,
                sinkModuleId: payload.sinkModuleId,
                sinkPortId: payload.sinkPortId,
            }, { guaranteeDelivery: true });
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [
                {
                    op: 'add',
                    path: '/connections/-',
                    value: {
                        id: connId,
                        sourceModuleId: payload.sourceModuleId,
                        sourcePortId: payload.sourcePortId,
                        sinkModuleId: payload.sinkModuleId,
                        sinkPortId: payload.sinkPortId,
                    },
                },
            ],
        });
    }

    private handleRoutingDisconnect(payload: {
        engineId: string;
        connectionId: string;
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            config.connections = connections.filter((c) => c.id !== payload.connectionId);
            return config;
        });

        // Send live disconnect command to engine (removes immediately)
        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'routingDisconnect',
                connectionId: payload.connectionId,
            }, { guaranteeDelivery: true });
        }

        // Broadcast the updated connections array (replace, not remove-by-id)
        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'replace', path: '/connections', value: updatedConfig?.connections ?? [] }],
        });
    }

    // --- Plugin listing ---

    private getAvailablePlugins(): Array<Record<string, unknown>> {
        const pluginsDir = path.resolve(__dirname, '../../../plugins');
        if (!fs.existsSync(pluginsDir)) return [];

        const plugins: Array<Record<string, unknown>> = [];
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const pkgPath = path.join(pluginsDir, entry.name, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;

            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                if (pkg.mediaRouter) {
                    plugins.push({
                        pluginId: pkg.mediaRouter.pluginId,
                        displayName: pkg.mediaRouter.displayName,
                        description: pkg.mediaRouter.description,
                        category: pkg.mediaRouter.category,
                        color: pkg.mediaRouter.color,
                        icon: pkg.mediaRouter.icon,
                        ports: pkg.mediaRouter.ports ?? [],
                        configSchema: pkg.mediaRouter.configSchema ?? {},
                        statusSections: pkg.mediaRouter.statusSections,
                    });
                }
            } catch {
                // Skip invalid plugins
            }
        }
        return plugins;
    }

    // --- HTTP Routes ---

    private setupHttpRoutes(): void {
        // Health
        this.app.get('/health', (_req, res) => {
            res.json({ status: 'ok', uptime: process.uptime() });
        });

        // Plugins
        this.app.get('/api/v1/plugins', (_req, res) => {
            res.json(this.getAvailablePlugins());
        });

        // Audio devices (query PipeWire via pactl with full descriptions + channel info)
        this.app.get('/api/v1/audio/devices', (_req, res) => {
            const devices: Array<{ name: string; description: string; direction: string; channels: number; sampleRate: number }> = [];
            try {
                // Helper to parse a pactl list block
                const parseDevices = (output: string, direction: string) => {
                    let name = '';
                    let description = '';
                    let channels = 2;
                    let sampleRate = 48000;
                    for (const line of output.split('\n')) {
                        const nameMatch = line.match(/^\s+Name:\s+(.+)/);
                        const descMatch = line.match(/^\s+Description:\s+(.+)/);
                        const specMatch = line.match(/^\s+Sample Specification:\s+\S+\s+(\d+)ch\s+(\d+)Hz/);
                        if (nameMatch) name = nameMatch[1];
                        if (descMatch) description = descMatch[1];
                        if (specMatch) {
                            channels = parseInt(specMatch[1], 10);
                            sampleRate = parseInt(specMatch[2], 10);
                        }
                        // Empty line = end of device block
                        if (line.trim() === '' && name && description) {
                            if (direction !== 'source' || !name.endsWith('.monitor')) {
                                devices.push({ name, description, direction, channels, sampleRate });
                            }
                            name = '';
                            description = '';
                            channels = 2;
                            sampleRate = 48000;
                        }
                    }
                    // Last device (no trailing empty line)
                    if (name && description) {
                        if (direction !== 'source' || !name.endsWith('.monitor')) {
                            devices.push({ name, description, direction, channels, sampleRate });
                        }
                    }
                };

                parseDevices(execSync('pactl list sinks 2>/dev/null', { encoding: 'utf-8' }), 'sink');
                parseDevices(execSync('pactl list sources 2>/dev/null', { encoding: 'utf-8' }), 'source');
            } catch {}
            res.json(devices);
        });

        // Engine CRUD
        this.app.get('/api/v1/engines', (_req, res) => {
            const engines = this.configStore.getAllEngines().map((e) => ({
                ...e,
                online: this.engineManager.isEngineOnline(e.engine_id as string),
            }));
            res.json(engines);
        });

        this.app.post('/api/v1/engines', (req, res) => {
            const { engineId, displayName, password } = req.body;
            if (!engineId || !displayName || !password) {
                res.status(400).json({
                    error: 'engineId, displayName, and password are required',
                });
                return;
            }
            if (this.configStore.getEngine(engineId)) {
                res.status(409).json({ error: 'Engine ID already exists' });
                return;
            }

            this.configStore.createEngine(engineId, displayName, password);
            this.configStore.createProfile(engineId, 'default', {});
            this.configStore.setActiveProfile(engineId, 'default');
            this.engineManager.refreshEncryptionKeys();

            const engine = this.configStore.getEngine(engineId)!;
            const result = {
                engine_id: engine.engine_id,
                display_name: engine.display_name,
                active_profile: engine.active_profile,
                online: false,
            };

            this.io.emit('engine:added', result);
            res.status(201).json(result);
        });

        this.app.put('/api/v1/engines/:id', (req, res) => {
            const engine = this.configStore.getEngine(req.params.id);
            if (!engine) {
                res.status(404).json({ error: 'Engine not found' });
                return;
            }
            const { displayName, password } = req.body;
            if (!displayName) {
                res.status(400).json({ error: 'displayName is required' });
                return;
            }
            this.configStore.updateEngine(req.params.id, displayName, password || undefined);
            if (password) this.engineManager.refreshEncryptionKeys();

            const updated = this.configStore.getEngine(req.params.id)!;
            const result = {
                engine_id: updated.engine_id,
                display_name: updated.display_name,
                active_profile: updated.active_profile,
                online: this.engineManager.isEngineOnline(req.params.id),
            };
            this.io.emit('engine:updated', result);
            res.json(result);
        });

        this.app.delete('/api/v1/engines/:id', (req, res) => {
            if (!this.configStore.getEngine(req.params.id)) {
                res.status(404).json({ error: 'Engine not found' });
                return;
            }
            this.configStore.deleteEngine(req.params.id);
            this.engineManager.refreshEncryptionKeys();
            this.io.emit('engine:removed', { engineId: req.params.id });
            res.json({ ok: true });
        });

        // Profile CRUD
        this.app.get('/api/v1/engines/:id/profiles', (req, res) => {
            res.json(this.configStore.getProfiles(req.params.id));
        });

        this.app.post('/api/v1/engines/:id/profiles', (req, res) => {
            const engine = this.configStore.getEngine(req.params.id);
            if (!engine) {
                res.status(404).json({ error: 'Engine not found' });
                return;
            }
            const { profileName, config } = req.body;
            if (!profileName) {
                res.status(400).json({ error: 'profileName is required' });
                return;
            }
            this.configStore.createProfile(req.params.id, profileName, config ?? {});
            res.status(201).json({ profile_name: profileName });
        });

        this.app.delete('/api/v1/engines/:id/profiles/:profile', (req, res) => {
            const engine = this.configStore.getEngine(req.params.id);
            if (!engine) {
                res.status(404).json({ error: 'Engine not found' });
                return;
            }
            if (engine.active_profile === req.params.profile) {
                res.status(400).json({ error: 'Cannot delete the active profile' });
                return;
            }
            this.configStore.deleteProfile(req.params.id, req.params.profile);
            res.json({ ok: true });
        });

        this.app.post('/api/v1/engines/:id/profiles/:profile/activate', (req, res) => {
            const engine = this.configStore.getEngine(req.params.id);
            if (!engine) { res.status(404).json({ error: 'Engine not found' }); return; }
            const profile = this.configStore.getProfile(req.params.id, req.params.profile);
            if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }
            this.configStore.setActiveProfile(req.params.id, req.params.profile);
            // Push new config to engine if online
            if (this.engineManager.isEngineOnline(req.params.id)) {
                this.engineManager.sendToEngine(req.params.id, 'config', profile, { guaranteeDelivery: true });
            }

            // Send full engine state with new profile's modules/connections to browsers
            const updatedEngine = this.configStore.getEngine(req.params.id);
            const modules = (profile.modules ?? {}) as Record<string, Record<string, unknown>>;
            const connections = (profile.connections ?? []) as unknown[];

            // Overlay live plugin manifests on modules
            const pluginManifests = this.getAvailablePlugins();
            for (const [, mod] of Object.entries(modules)) {
                const manifest = pluginManifests.find((p) => p.pluginId === mod.pluginId);
                if (manifest) {
                    mod.ports = manifest.ports ?? [];
                    mod.configSchema = manifest.configSchema ?? {};
                    mod.statusSections = manifest.statusSections;
                    mod.color = manifest.color;
                    mod.icon = manifest.icon;
                }
            }

            // Replace entire engine state in browsers
            this.io.emit('engine:update', {
                engineId: req.params.id,
                patch: [
                    { op: 'replace', path: '/activeProfile', value: req.params.profile },
                    { op: 'replace', path: '/modules', value: modules },
                    { op: 'replace', path: '/connections', value: connections },
                ],
            });
            res.json({ ok: true });
        });

        this.app.get('/api/v1/engines/:id/profiles/:profile/config', (req, res) => {
            const config = this.configStore.getProfile(req.params.id, req.params.profile);
            if (!config) { res.status(404).json({ error: 'Profile not found' }); return; }
            res.json(config);
        });

        this.app.get('/api/v1/engines/:id/profiles/:profile/history', (req, res) => {
            res.json(
                this.configStore.getVersionHistory(req.params.id, req.params.profile),
            );
        });

        this.app.post('/api/v1/engines/:id/profiles/:profile/rollback', (req, res) => {
            const { versionId } = req.body as { versionId: number };
            if (!versionId) { res.status(400).json({ error: 'versionId required' }); return; }
            const version = this.configStore.getVersion(req.params.id, req.params.profile, versionId);
            if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
            this.configStore.updateProfileConfig(req.params.id, req.params.profile, version);
            res.json({ ok: true });
        });

        // Static file serving (manager-ui)
        const uiDistPath = path.resolve(__dirname, '../../manager-ui/dist');
        if (fs.existsSync(uiDistPath)) {
            this.app.use(express.static(uiDistPath));
            // SPA fallback — only for non-API routes
            this.app.get('/{*path}', (req, res) => {
                if (req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
                    res.status(404).json({ error: 'Not found' });
                    return;
                }
                res.sendFile(path.join(uiDistPath, 'index.html'));
            });
        } else {
            this.app.get('/', (_req, res) => {
                res.json({
                    status: 'ok',
                    message: 'Manager API running. UI not built — run: pnpm --filter @media-router/manager-ui build',
                });
            });
        }
    }

    /** Persist engine running state in profile config. */
    private setEngineRunning(engineId: string, running: boolean): void {
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) return;
        this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
            config.running = running;
            return config;
        });
    }

    /** Get persisted running state for an engine. */
    private getEngineRunning(engineId: string): boolean {
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) return false;
        const config = this.configStore.getProfile(engineId, engine.active_profile as string);
        return (config?.running as boolean) ?? false;
    }

    getConfigStore(): ConfigStore {
        return this.configStore;
    }

    getEngineManager(): EngineConnectionManager {
        return this.engineManager;
    }

    /**
     * Send a start/stop command to an engine with retry.
     * If the engine is offline, retries every 2s up to 5 times.
     */
    private sendEngineCommand(engineId: string, command: 'start' | 'stop'): void {
        const maxRetries = 5;
        const retryInterval = 2000;
        let attempt = 0;

        const trySend = () => {
            attempt++;
            // Check if the running state still matches (user may have toggled again)
            const shouldBeRunning = this.getEngineRunning(engineId);
            if ((command === 'start' && !shouldBeRunning) || (command === 'stop' && shouldBeRunning)) {
                log.info({ engineId, command }, 'Command cancelled — running state changed');
                return;
            }

            if (!this.engineManager.isEngineOnline(engineId)) {
                if (attempt < maxRetries) {
                    log.warn({ engineId, command, attempt }, 'Engine offline — retrying');
                    setTimeout(trySend, retryInterval);
                } else {
                    log.error({ engineId, command }, 'Engine offline — giving up after retries');
                }
                return;
            }

            // For start: push config first
            if (command === 'start') {
                const engine = this.configStore.getEngine(engineId);
                if (engine?.active_profile) {
                    const config = this.configStore.getProfile(engineId, engine.active_profile as string);
                    if (config) {
                        this.engineManager.sendToEngine(engineId, 'config', config, { guaranteeDelivery: true });
                    }
                }
            }

            log.info({ engineId, command, attempt }, 'Sending engine command');
            this.engineManager.sendToEngine(engineId, 'command', { command }, { guaranteeDelivery: true });
        };

        trySend();
    }
}

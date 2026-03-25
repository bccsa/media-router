import type { Server as SocketIOServer } from 'socket.io';
import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { EngineCommandService } from './EngineCommandService.js';

const log = createLogger('EngineEventForwarder');

/**
 * Wires engine events (online/offline, state, VU, logs, system stats)
 * to Socket.IO emissions and manages cached state for new browser connections.
 */
export class EngineEventForwarder {
    /** Ring buffer of recent log entries per engine. */
    private logBuffers = new Map<string, unknown[]>();
    /** Cached module runtime states per engine. */
    private cachedModuleStates = new Map<string, Record<string, unknown>>();
    /** Generic per-engine data cache — keyed by topic (e.g. 'audioDevices', 'networkInterfaces'). */
    private engineData = new Map<string, Map<string, unknown>>();
    private readonly LOG_BUFFER_MAX = 1000;

    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private engineCommands: EngineCommandService,
        private io: SocketIOServer,
    ) {}

    /** Wire all engine events. Call once during Manager construction. */
    setup(): void {
        this.engineManager.on('engineOnline', (engineId: string) => {
            this.io.emit('engine:online', { engineId });

            if (this.engineCommands.isRunning(engineId)) {
                log.info({ engineId }, 'engine reconnected — auto-sending start');
                this.engineCommands.sendCommand(engineId, 'start');
            }
        });

        this.engineManager.on('engineOffline', (engineId: string) => {
            this.cachedModuleStates.delete(engineId);
            this.engineData.delete(engineId);
            this.io.emit('engine:offline', { engineId });
        });

        this.engineManager.on('engineState', (engineId: string, state: unknown) => {
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
            this.io.volatile.emit('engine:system', { engineId, ...(data as Record<string, unknown>) });
        });

        this.engineManager.on('engineConfigUpdated', (engineId: string, data: unknown) => {
            const d = data as { instanceId: string; changes: Record<string, unknown> };
            if (!d?.instanceId || !d?.changes) return;

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

            const patches = Object.entries(d.changes).map(([key, value]) => ({
                op: 'replace' as const,
                path: `/modules/${d.instanceId}/settings/${key}`,
                value,
            }));
            this.io.emit('engine:update', { engineId, patch: patches });
        });

        this.engineManager.on('engineLogs', (engineId: string, batch: unknown) => {
            if (!Array.isArray(batch)) return;

            let buffer = this.logBuffers.get(engineId);
            if (!buffer) {
                buffer = [];
                this.logBuffers.set(engineId, buffer);
            }
            buffer.push(...batch);
            if (buffer.length > this.LOG_BUFFER_MAX) {
                buffer.splice(0, buffer.length - this.LOG_BUFFER_MAX);
            }

            this.io.to(`watch:${engineId}`).volatile.emit('engine:logs', { engineId, entries: batch });
        });

        this.engineManager.on('engineAudioDevices', (engineId: string, devices: unknown) => {
            this.setEngineData(engineId, 'audioDevices', devices);
        });

        // LCP config updates — persist to SQLite without sending config back to engine
        this.engineManager.on('engineLcpConfig', (engineId: string, data: unknown) => {
            const { moduleId, changes } = data as { moduleId: string; changes: Record<string, unknown> };
            if (!moduleId || !changes) return;
            // 1. Save to SQLite
            const engine = this.configStore.getEngine(engineId);
            if (!engine?.active_profile) return;
            this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
                const modules = config.modules as Record<string, Record<string, unknown>> | undefined;
                const mod = modules?.[moduleId];
                if (mod?.settings) {
                    Object.assign(mod.settings as Record<string, unknown>, changes);
                }
                return config;
            });
            // 2. Broadcast to all browser clients (manager-ui)
            // DO NOT send moduleConfig back to engine — source was LCP via engine, loop stops here
            const patch = Object.entries(changes).map(([key, value]) => ({
                op: 'replace' as const,
                path: `/modules/${moduleId}/settings/${key}`,
                value,
            }));
            this.io.emit('engine:update', { engineId, patch });
        });

        // LCP start/stop commands — update running state + broadcast to browsers
        this.engineManager.on('engineLcpCommand', (engineId: string, data: unknown) => {
            const { command } = data as { command: 'start' | 'stop' };
            if (!command) return;
            const running = command === 'start';
            this.engineCommands.setRunning(engineId, running);
            this.io.emit('engine:running', { engineId, running });
        });
    }

    /** Store arbitrary data for an engine (keyed by topic). */
    setEngineData(engineId: string, topic: string, data: unknown): void {
        if (!this.engineData.has(engineId)) this.engineData.set(engineId, new Map());
        this.engineData.get(engineId)!.set(topic, data);
    }

    /** Retrieve cached engine data by topic. */
    getEngineData(engineId: string, topic: string): unknown {
        return this.engineData.get(engineId)?.get(topic);
    }

    /** Get cached runtime states for an engine (used when browser connects). */
    getCachedStates(engineId: string): Record<string, unknown> {
        return this.cachedModuleStates.get(engineId) ?? {};
    }

    /** Get log buffer for an engine (used for logs:history request). */
    getLogBuffer(engineId: string): unknown[] {
        return this.logBuffers.get(engineId) ?? [];
    }

}

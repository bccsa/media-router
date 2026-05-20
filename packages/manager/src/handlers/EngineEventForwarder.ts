import type { Server as SocketIOServer } from 'socket.io';
import {
    createLogger,
    safeParse,
    EngineRunningStateSchema,
    LcpEngineCommandSchema,
    DynamicPortsSchema,
    RebootFailedSchema,
} from '@media-router/shared-types';
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
            // Don't auto-send start here — wait for engine to report its running state
        });

        // Engine reports its running state on connect. Manager state is authoritative.
        this.engineManager.on('engineRunningState', (engineId: string, data: unknown) => {
            const parsed = safeParse(EngineRunningStateSchema, data, 'engineRunningState', log);
            if (!parsed) return;
            const { running: engineRunning } = parsed;
            const managerWantsRunning = this.engineCommands.isRunning(engineId);

            if (managerWantsRunning && !engineRunning) {
                // Manager=run, Engine=stopped → start engine
                log.info({ engineId }, 'Engine connected stopped — sending start');
                this.engineCommands.sendCommand(engineId, 'start');
            } else if (managerWantsRunning && engineRunning) {
                // Manager=run, Engine=running → push config, no restart
                log.info({ engineId }, 'Engine already running — pushing config');
                const engine = this.configStore.getEngine(engineId);
                if (engine?.active_profile) {
                    const config = this.configStore.getProfile(
                        engineId,
                        engine.active_profile as string,
                    );
                    if (config) {
                        this.engineManager.sendToEngine(engineId, 'config', config, {
                            guaranteeDelivery: true,
                        });
                    }
                }
            } else if (!managerWantsRunning && engineRunning) {
                // Manager=stop, Engine=running → stop engine
                log.info({ engineId }, 'Manager wants stopped — sending stop');
                this.engineCommands.sendCommand(engineId, 'stop');
            }
            // Manager=stop, Engine=stopped → do nothing
        });

        this.engineManager.on('engineOffline', (engineId: string) => {
            this.cachedModuleStates.delete(engineId);
            this.engineData.delete(engineId);
            this.logBuffers.delete(engineId);
            this.io.emit('engine:offline', { engineId });
        });

        this.engineManager.on('engineState', (engineId: string, state: unknown) => {
            if (typeof state !== 'object' || state === null) {
                log.warn({ engineId }, 'engineState: expected object, dropping');
                return;
            }
            this.cachedModuleStates.set(engineId, {
                ...(this.cachedModuleStates.get(engineId) ?? {}),
                ...(state as Record<string, unknown>),
            });
            this.io.emit('engine:state', { engineId, state });
        });

        this.engineManager.on('engineVu', (engineId: string, data: unknown) => {
            if (typeof data !== 'object' || data === null) return;
            this.io
                .to(`watch:${engineId}`)
                .volatile.emit('engine:vu', { engineId, ...(data as Record<string, unknown>) });
        });

        this.engineManager.on('engineSystem', (engineId: string, data: unknown) => {
            if (typeof data !== 'object' || data === null) return;
            const d = data as Record<string, unknown>;
            // Cache IP + hostname + build when engine reports them
            if (d.ip) this.setEngineData(engineId, 'ip', d.ip);
            if (d.ips) this.setEngineData(engineId, 'ips', d.ips);
            if (d.hostname) this.setEngineData(engineId, 'hostname', d.hostname);
            if (d.buildNumber) this.setEngineData(engineId, 'buildNumber', d.buildNumber);
            this.io.volatile.emit('engine:system', { engineId, ...d });
        });

        // engineConfigUpdated, engineLcpConfig, engineDynamicPorts now handled by enginePatch → PatchRouter

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

            this.io
                .to(`watch:${engineId}`)
                .volatile.emit('engine:logs', { engineId, entries: batch });
        });

        // Cache per-type + fan out to the engine's watchers so dropdowns live-update.
        this.engineManager.on('engineDeviceList', (engineId: string, data: unknown) => {
            const payload = data as { type?: string; devices?: unknown } | undefined;
            if (!payload || typeof payload.type !== 'string') {
                log.warn({ engineId, data }, 'engineDeviceList payload missing type');
                return;
            }
            const { type, devices } = payload;
            this.setEngineData(engineId, `devices:${type}`, devices);
            this.io
                .to(`watch:${engineId}`)
                .emit('engine:deviceList', { engineId, type, devices });
        });

        // LCP start/stop commands — update running state + broadcast to browsers
        this.engineManager.on('engineLcpCommand', (engineId: string, data: unknown) => {
            const parsed = safeParse(LcpEngineCommandSchema, data, 'engineLcpCommand', log);
            if (!parsed) return;
            const { command } = parsed;
            const running = command === 'start';
            this.engineCommands.setRunning(engineId, running);
            this.io.emit('engine:running', { engineId, running });
        });

        // Host reboot failed — typically a polkit denial. Surface to browsers
        // so the operator gets feedback instead of a silent non-reboot.
        this.engineManager.on('engineRebootFailed', (engineId: string, data: unknown) => {
            const parsed = safeParse(RebootFailedSchema, data, 'engineRebootFailed', log);
            if (!parsed) return;
            this.io.emit('engine:rebootFailed', { engineId, reason: parsed.reason });
        });

        // Dynamic port updates — persist to config + broadcast to browsers
        this.engineManager.on('engineDynamicPorts', (engineId: string, data: unknown) => {
            const parsed = safeParse(DynamicPortsSchema, data, 'engineDynamicPorts', log);
            if (!parsed) return;
            const { moduleId, ports } = parsed;
            // 1. Update stored config
            const engine = this.configStore.getEngine(engineId);
            if (engine?.active_profile) {
                this.configStore.modifyProfileConfig(
                    engineId,
                    engine.active_profile as string,
                    (config) => {
                        const modules = config.modules as
                            | Record<string, Record<string, unknown>>
                            | undefined;
                        if (modules?.[moduleId]) {
                            modules[moduleId].ports = ports;
                        }
                        return config;
                    },
                );
            }
            // 2. Broadcast to browsers
            this.io.emit('engine:update', {
                engineId,
                patch: [{ op: 'replace', path: `/modules/${moduleId}/ports`, value: ports }],
            });
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

    /**
     * Re-key cached per-engine state after an engine_id rename. Without this
     * the live UDP session keeps emitting events under `oldId` and the
     * manager's caches accumulate two parallel sets — the rename's
     * `engine:renamed` payload would even report `online: false` against
     * `newId` while the engine is still actively talking under `oldId`.
     */
    notifyRename(oldId: string, newId: string): void {
        if (oldId === newId) return;
        const moduleStates = this.cachedModuleStates.get(oldId);
        if (moduleStates !== undefined) {
            this.cachedModuleStates.delete(oldId);
            this.cachedModuleStates.set(newId, moduleStates);
        }
        const engineData = this.engineData.get(oldId);
        if (engineData !== undefined) {
            this.engineData.delete(oldId);
            this.engineData.set(newId, engineData);
        }
        const logBuffer = this.logBuffers.get(oldId);
        if (logBuffer !== undefined) {
            this.logBuffers.delete(oldId);
            this.logBuffers.set(newId, logBuffer);
        }
    }
}

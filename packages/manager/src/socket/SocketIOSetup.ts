import type { Server as SocketIOServer, Socket as IOSocket } from 'socket.io';
import { createLogger, validated, EngineIdPayloadSchema, ModuleRestartPayloadSchema, BrowserPatchPayloadSchema } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { EngineCommandService } from '../handlers/EngineCommandService.js';
import type { EngineEventForwarder } from '../handlers/EngineEventForwarder.js';
import type { PatchRouter } from '../PatchRouter.js';

const log = createLogger('SocketIO');

export interface SocketDeps {
    io: SocketIOServer;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
    engineCommands: EngineCommandService;
    eventForwarder: EngineEventForwarder;
    patchRouter: PatchRouter;
}

/**
 * Register all Socket.IO event handlers.
 * Config changes go through 'patch' (N-1 router).
 * Lifecycle commands (start/stop/reset/restart) stay as direct events.
 * Streams (VU/logs/system/state) are handled by EngineEventForwarder.
 */
export function setupSocketIO(deps: SocketDeps): void {
    const { io, configStore, engineManager, pluginRegistry, engineCommands, eventForwarder, patchRouter } = deps;

    io.on('connection', (socket: IOSocket) => {
        log.info({ socketId: socket.id }, 'browser connected');

        // --- Send full state on connect ---
        const engines = configStore.getAllEngines();
        const pluginManifests = pluginRegistry.getAll();
        socket.emit(
            'engine:list',
            engines.map((e) => {
                let modules: Record<string, unknown> = {};
                let connections: unknown[] = [];

                if (e.active_profile) {
                    const profileConfig = configStore.getProfile(
                        e.engine_id as string,
                        e.active_profile as string,
                    );
                    if (profileConfig) {
                        modules = (profileConfig.modules ?? {}) as Record<string, unknown>;
                        connections = (profileConfig.connections ?? []) as unknown[];
                    }
                }

                // Overlay live plugin manifest + cached runtime state (clone to avoid mutating ConfigStore)
                const cachedStates = eventForwarder.getCachedStates(e.engine_id as string);
                for (const [id, mod] of Object.entries(modules)) {
                    const m = modules[id] = { ...(mod as Record<string, unknown>) };
                    const manifest = pluginManifests.find((p) => p.pluginId === m.pluginId);
                    if (manifest) {
                        if (!m.ports || (m.ports as unknown[]).length === 0) m.ports = manifest.ports ?? [];
                        m.configSchema = manifest.configSchema ?? {};
                        m.color = manifest.color;
                        m.icon = manifest.icon;
                        m.statusSections = manifest.statusSections;
                        m.faceWidgets = manifest.faceWidgets;
                    }
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
                    online: engineManager.isEngineOnline(e.engine_id as string),
                    running: engineCommands.isRunning(e.engine_id as string),
                    ip: eventForwarder.getEngineData(e.engine_id as string, 'ip'),
                    ips: eventForwarder.getEngineData(e.engine_id as string, 'ips'),
                    hostname: eventForwarder.getEngineData(e.engine_id as string, 'hostname'),
                    buildNumber: eventForwarder.getEngineData(e.engine_id as string, 'buildNumber'),
                    modules,
                    connections,
                };
            }),
        );

        // --- Watch engine (stream VU/logs/system only for active engine) ---
        socket.on('watch:engine', validated(EngineIdPayloadSchema, log, ({ engineId }) => {
            for (const room of socket.rooms) {
                if (room.startsWith('watch:')) socket.leave(room);
            }
            socket.join(`watch:${engineId}`);
        }));

        // --- Log history (has callback arg — use validated with rest passthrough) ---
        socket.on('logs:history', (raw: unknown, callback?: (entries: unknown[]) => void) => {
            const result = EngineIdPayloadSchema.safeParse(raw);
            if (!result.success) return;
            const buffer = eventForwarder.getLogBuffer(result.data.engineId);
            if (typeof callback === 'function') {
                callback(buffer);
            } else {
                socket.emit('logs:history', { engineId: result.data.engineId, entries: buffer });
            }
        });

        /** Check engineId is a non-empty string and the engine exists. */
        const validEngine = (engineId: unknown): engineId is string =>
            typeof engineId === 'string' && engineId.length > 0 && !!configStore.getEngine(engineId);

        // --- Lifecycle commands (not patches) ---
        socket.on('engine:start', validated(EngineIdPayloadSchema, log, ({ engineId }) => {
            if (!validEngine(engineId)) return;
            engineCommands.setRunning(engineId, true);
            engineCommands.sendCommand(engineId, 'start');
            io.emit('engine:running', { engineId, running: true });
        }));
        socket.on('engine:stop', validated(EngineIdPayloadSchema, log, ({ engineId }) => {
            if (!validEngine(engineId)) return;
            engineCommands.setRunning(engineId, false);
            engineCommands.sendCommand(engineId, 'stop');
            io.emit('engine:running', { engineId, running: false });
        }));
        socket.on('engine:reset', validated(EngineIdPayloadSchema, log, ({ engineId }) => {
            if (!validEngine(engineId)) return;
            if (engineManager.isEngineOnline(engineId)) {
                engineManager.sendToEngine(engineId, 'command', { command: 'reset' }, { guaranteeDelivery: true });
            }
        }));
        socket.on('module:restart', validated(ModuleRestartPayloadSchema, log, ({ engineId, moduleId }) => {
            if (!validEngine(engineId)) return;
            if (engineManager.isEngineOnline(engineId)) {
                engineManager.sendToEngine(engineId, 'command', {
                    command: 'moduleRestart', moduleId,
                }, { guaranteeDelivery: true });
            }
        }));

        // --- Unified patch (N-1 router) ---
        socket.on('patch', validated(BrowserPatchPayloadSchema, log, ({ engineId, ops }) => {
            if (!validEngine(engineId)) return;
            patchRouter.onPatch(socket.id, 'browser', engineId, ops);
        }));

        socket.on('disconnect', () => {
            log.info({ socketId: socket.id }, 'browser disconnected');
        });
    });
}

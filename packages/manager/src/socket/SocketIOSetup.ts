import type { Server as SocketIOServer, Socket as IOSocket } from 'socket.io';
import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { ModuleHandlers } from '../handlers/ModuleHandlers.js';
import type { RoutingHandlers } from '../handlers/RoutingHandlers.js';
import type { EngineCommandService } from '../handlers/EngineCommandService.js';
import type { EngineEventForwarder } from '../handlers/EngineEventForwarder.js';

const log = createLogger('SocketIO');

export interface SocketDeps {
    io: SocketIOServer;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
    moduleHandlers: ModuleHandlers;
    routingHandlers: RoutingHandlers;
    engineCommands: EngineCommandService;
    eventForwarder: EngineEventForwarder;
}

/**
 * Register all Socket.IO event handlers.
 * This is a thin wiring layer — all business logic lives in handler classes.
 */
export function setupSocketIO(deps: SocketDeps): void {
    const { io, configStore, engineManager, pluginRegistry, moduleHandlers, routingHandlers, engineCommands, eventForwarder } = deps;

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

                // Overlay live plugin manifest on stored modules
                const cachedStates = eventForwarder.getCachedStates(e.engine_id as string);
                for (const [id, mod] of Object.entries(modules)) {
                    const m = mod as Record<string, unknown>;
                    const manifest = pluginManifests.find((p) => p.pluginId === m.pluginId);
                    if (manifest) {
                        m.ports = manifest.ports ?? [];
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
                    modules,
                    connections,
                };
            }),
        );

        // --- Watch engine (stream VU/logs/system only for active engine) ---
        socket.on('watch:engine', (payload: { engineId: string }) => {
            for (const room of socket.rooms) {
                if (room.startsWith('watch:')) socket.leave(room);
            }
            if (payload.engineId) {
                socket.join(`watch:${payload.engineId}`);
            }
        });

        // --- Log history ---
        socket.on('logs:history', (payload: { engineId: string }, callback?: (entries: unknown[]) => void) => {
            const buffer = eventForwarder.getLogBuffer(payload.engineId);
            if (typeof callback === 'function') {
                callback(buffer);
            } else {
                socket.emit('logs:history', { engineId: payload.engineId, entries: buffer });
            }
        });

        // --- Module management ---
        socket.on('module:add', (p: any) => { if (p?.engineId && p?.pluginId && p?.displayName) moduleHandlers.add(p); });
        socket.on('module:delete', (p: any) => { if (p?.engineId && p?.moduleId) moduleHandlers.delete(p); });
        socket.on('module:position', (p: any) => { if (p?.engineId && p?.moduleId && p?.position) moduleHandlers.position(p); });
        socket.on('module:config', (p: any) => { if (p?.engineId && p?.moduleId && p?.changes) moduleHandlers.config(p); });
        socket.on('module:toggle', (p: any) => { if (p?.engineId && p?.moduleId) moduleHandlers.toggle(p); });
        socket.on('module:restart', (p: any) => { if (p?.engineId && p?.moduleId) moduleHandlers.restart(p); });
        socket.on('module:meta', (p: any) => { if (p?.engineId && p?.moduleId && p?.meta) moduleHandlers.meta(p); });
        socket.on('module:rename', (p: any) => { if (p?.engineId && p?.moduleId && p?.displayName) moduleHandlers.rename(p); });

        // --- Engine start/stop ---
        socket.on('engine:start', (p: any) => {
            if (!p?.engineId) return;
            engineCommands.setRunning(p.engineId, true);
            engineCommands.sendCommand(p.engineId, 'start');
            io.emit('engine:running', { engineId: p.engineId, running: true });
        });
        socket.on('engine:stop', (p: any) => {
            if (!p?.engineId) return;
            engineCommands.setRunning(p.engineId, false);
            engineCommands.sendCommand(p.engineId, 'stop');
            io.emit('engine:running', { engineId: p.engineId, running: false });
        });

        socket.on('engine:reset', (p: any) => {
            if (!p?.engineId) return;
            if (engineManager.isEngineOnline(p.engineId)) {
                engineManager.sendToEngine(p.engineId, 'command', { command: 'reset' }, { guaranteeDelivery: true });
            }
        });

        // --- Routing ---
        socket.on('routing:connect', (p: any) => {
            if (p?.engineId && p?.sourceModuleId && p?.sourcePortId && p?.sinkModuleId && p?.sinkPortId) routingHandlers.connect(p);
        });
        socket.on('routing:disconnect', (p: any) => { if (p?.engineId && p?.connectionId) routingHandlers.disconnect(p); });
        socket.on('routing:update', (p: any) => { if (p?.engineId && p?.connectionId) routingHandlers.update(p); });

        socket.on('disconnect', () => {
            log.info({ socketId: socket.id }, 'browser disconnected');
        });
    });
}

import { Server as HttpServer, createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { EventEmitter } from 'events';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('LcpServer');

/**
 * Socket.IO server for the Local Control Panel (LCP).
 *
 * Broadcasts module states to all connected LCP clients.
 * Receives control commands (volume, mute, start/stop) from LCP.
 *
 * Emits:
 *   - 'control' (command) — LCP sent a control command
 */
export class LcpServer extends EventEmitter {
    private httpServer: HttpServer;
    private io: SocketIOServer;
    private port: number;

    constructor(port = 8081) {
        super();
        this.port = port;
        this.httpServer = createServer();
        this.io = new SocketIOServer(this.httpServer, {
            cors: { origin: '*' },
        });

        this.io.on('connection', (socket) => {
            log.info({ socketId: socket.id }, 'Client connected');

            // LCP sends control commands
            socket.on('control', (command: unknown) => {
                this.emit('control', command);
            });

            socket.on('volume', (data: unknown) => {
                this.emit('control', { action: 'volume', ...(data as Record<string, unknown>) });
            });

            socket.on('mute', (data: unknown) => {
                this.emit('control', { action: 'mute', ...(data as Record<string, unknown>) });
            });

            socket.on('start', (data: unknown) => {
                this.emit('control', { action: 'start', ...(data as Record<string, unknown>) });
            });

            socket.on('stop', (data: unknown) => {
                this.emit('control', { action: 'stop', ...(data as Record<string, unknown>) });
            });

            // LCP client requests full config (initial sync)
            socket.on('requestConfig', () => {
                this.emit('configRequested', socket.id);
            });

            socket.on('disconnect', () => {
                log.info({ socketId: socket.id }, 'Client disconnected');
            });
        });
    }

    /** Start listening. */
    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.httpServer.listen(this.port, () => {
                log.info({ port: this.port }, 'Socket.IO server listening');
                resolve();
            });
        });
    }

    /** Stop the server. */
    async stop(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.io.close(() => resolve());
        });
        this.removeAllListeners();
        return new Promise((resolve) => {
            this.httpServer.close(() => resolve());
        });
    }

    /** Broadcast module state to all LCP clients. */
    broadcastState(instanceId: string, state: ModuleRuntimeState): void {
        this.io.emit('moduleState', { instanceId, state });
    }

    /** Broadcast all module states (for initial sync on connect). */
    broadcastAllStates(states: Record<string, ModuleRuntimeState>): void {
        this.io.emit('allStates', states);
    }

    /** Send initial state to a newly connected client. */
    sendInitialState(states: Record<string, ModuleRuntimeState>): void {
        // This is called per-connection in the io.on('connection') handler
        // For now, broadcast to all (simple approach)
        this.broadcastAllStates(states);
    }

    /**
     * Broadcast config/routing changes to all LCP clients (JSON Patch format).
     * Used when the engine receives config updates from the manager.
     */
    broadcastConfigUpdate(patch: unknown[]): void {
        this.io.emit('configUpdate', patch);
    }

    /**
     * Send full config to a specific socket (for initial sync on requestConfig).
     */
    sendConfigToSocket(socketId: string, config: Record<string, unknown>): void {
        this.io.to(socketId).emit('config', config);
    }
}

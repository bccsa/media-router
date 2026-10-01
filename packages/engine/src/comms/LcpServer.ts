import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { EventEmitter } from 'events';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger, validated, PatchEnvelopeSchema } from '@media-router/shared-types';

const log = createLogger('LcpServer');

/**
 * The Local Control Panel's Socket.IO (default path) on the router's :8081
 * server, kept alongside dashboards until the fleet has moved (ADR-0026).
 * Its pages are served by LocalServer.
 *
 * Emits:
 *   - 'control' (command) — LCP Start/Stop
 *   - 'patch' ({ ops, _socketId }) — LCP value changes
 */
export class LcpServer extends EventEmitter {
    private io: SocketIOServer | null = null;
    /** Callback for the init payload (config + states + running). Set by Engine. */
    _getInitData: (() => Record<string, unknown>) | null = null;
    _engineRunning = false;

    /** Serve LCP clients on `http` (shared with the dashboards and the router tree). */
    attach(http: HttpServer): void {
        // Any local-network origin: the LCP is opened by browsers on the LAN.
        this.io = new SocketIOServer(http, { cors: { origin: (_origin, cb) => cb(null, true) } });
        this.io.on('connection', (socket) => {
            log.info({ socketId: socket.id }, 'Client connected');
            if (this._getInitData) socket.emit('init', this._getInitData());
            socket.on('start', () => this.emit('control', { action: 'start' }));
            socket.on('stop', () => this.emit('control', { action: 'stop' }));
            socket.on(
                'patch',
                validated(PatchEnvelopeSchema, log, ({ ops }) => this.emit('patch', { ops, _socketId: socket.id })),
            );
            socket.on('disconnect', () => log.info({ socketId: socket.id }, 'Client disconnected'));
        });
    }

    async close(): Promise<void> {
        this.removeAllListeners();
        const io = this.io;
        this.io = null;
        // `io.close()` would close the shared HTTP server too: drop the clients only.
        io?.disconnectSockets(true);
    }

    broadcastState(instanceId: string, state: ModuleRuntimeState): void {
        this.io?.emit('moduleState', { instanceId, state });
    }

    broadcastAllStates(states: Record<string, ModuleRuntimeState>): void {
        this.io?.emit('allStates', states);
    }

    sendInitialState(states: Record<string, ModuleRuntimeState>): void {
        this.broadcastAllStates(states);
    }

    broadcastVuData(instanceId: string, vuData: number[]): void {
        this.io?.volatile.emit('vuData', { instanceId, vuData });
    }

    broadcastEngineRunning(running: boolean): void {
        this._engineRunning = running;
        this.io?.emit('engineRunning', running);
    }

    /** Config changes (JSON Patch) to every LCP client. */
    broadcastConfigUpdate(patch: unknown[]): void {
        this.io?.emit('configUpdate', patch);
    }

    /** Config changes to every LCP client but the one that made them. */
    broadcastConfigUpdateExcept(excludeSocketId: string, patch: unknown[]): void {
        this.io?.except(excludeSocketId).emit('configUpdate', patch);
    }

    sendConfigToSocket(socketId: string, config: Record<string, unknown>): void {
        this.io?.to(socketId).emit('config', config);
    }
}

import { Server as HttpServer, createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger, validated, PatchEnvelopeSchema } from '@media-router/shared-types';

const log = createLogger('LcpServer');

/** MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

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
    /** Callback to get combined init data (config + states + running). Set by Engine. */
    _getInitData: (() => Record<string, unknown>) | null = null;
    private port: number;
    private _engineRunning = false;

    /** Resolved path to local-panel/dist for static serving. Null if not found. */
    private staticDir: string | null = null;

    constructor(port = 8081) {
        super();
        this.port = port;
        this.staticDir = this.findStaticDir();
        this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
        // Allow connections from any local-network origin (the LCP is accessed by
        // browsers on the same LAN). Using a callback instead of '*' so Socket.IO
        // can set Access-Control-Allow-Credentials if needed in the future.
        this.io = new SocketIOServer(this.httpServer, {
            cors: { origin: (_origin, cb) => cb(null, true) },
        });

        this.io.on('connection', (socket) => {
            log.info({ socketId: socket.id }, 'Client connected');

            // Send combined init payload — config + runtime states + engineRunning in one event
            // The getInitData callback is set by Engine.ts
            if (this._getInitData) {
                socket.emit('init', this._getInitData());
            }

            // LCP lifecycle commands (stay as direct events)
            socket.on('start', () => {
                this.emit('control', { action: 'start' });
            });

            socket.on('stop', () => {
                this.emit('control', { action: 'stop' });
            });

            // Unified patch from LCP (N-1 router)
            socket.on('patch', validated(PatchEnvelopeSchema, log, ({ ops }) => {
                this.emit('patch', { ops, _socketId: socket.id });
            }));

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

    /** Broadcast VU meter data to all LCP clients. */
    broadcastVuData(instanceId: string, vuData: number[]): void {
        this.io.volatile.emit('vuData', { instanceId, vuData });
    }

    /** Broadcast engine running state to all LCP clients. */
    broadcastEngineRunning(running: boolean): void {
        this._engineRunning = running;
        this.io.emit('engineRunning', running);
    }

    /**
     * Broadcast config/routing changes to all LCP clients (JSON Patch format).
     * Used when the engine receives config updates from the manager.
     */
    broadcastConfigUpdate(patch: unknown[]): void {
        this.io.emit('configUpdate', patch);
    }

    /**
     * Broadcast config update to all LCP clients EXCEPT the sender.
     * Used when a LCP client changes config — skip the originator.
     */
    broadcastConfigUpdateExcept(excludeSocketId: string, patch: unknown[]): void {
        this.io.except(excludeSocketId).emit('configUpdate', patch);
    }

    /**
     * Send full config to a specific socket (for initial sync on requestConfig).
     */
    sendConfigToSocket(socketId: string, config: Record<string, unknown>): void {
        this.io.to(socketId).emit('config', config);
    }

    // --- Static file serving for LCP UI ---

    /** Find the local-panel/dist directory by walking up from engine package. */
    private findStaticDir(): string | null {
        // Try common locations relative to this file / cwd
        const candidates = [
            path.resolve(__dirname, '../../../local-panel/dist'),         // dev: packages/engine/src → packages/local-panel/dist
            path.resolve(__dirname, '../../../../local-panel/dist'),      // dev: packages/engine/dist → packages/local-panel/dist
            path.resolve(process.cwd(), '../local-panel/dist'),          // packages/engine cwd
            path.resolve(process.cwd(), 'local-panel/dist'),             // repo root cwd (Yocto)
            path.resolve(process.cwd(), 'packages/local-panel/dist'),    // repo root cwd
        ];
        for (const dir of candidates) {
            if (fs.existsSync(path.join(dir, 'index.html'))) {
                log.info({ path: dir }, 'Found LCP static files');
                return dir;
            }
        }
        log.warn('LCP static files not found — port 8081 will only serve Socket.IO');
        return null;
    }

    /** Handle HTTP requests — serve static files or 404. */
    private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
        if (!this.staticDir) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('LCP UI not built');
            return;
        }

        let urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath === '/') urlPath = '/index.html';

        const filePath = path.join(this.staticDir, urlPath);

        // Security: prevent directory traversal
        if (!filePath.startsWith(this.staticDir + path.sep) && filePath !== this.staticDir) {
            res.writeHead(403);
            res.end();
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                // SPA fallback — serve index.html for non-asset routes
                if (!/\.(js|css|png|svg|ico|json|woff2?)$/.test(urlPath)) {
                    fs.readFile(path.join(this.staticDir!, 'index.html'), (err2, html) => {
                        if (err2) { res.writeHead(404); res.end('Not found'); return; }
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(html);
                    });
                    return;
                }
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const ext = path.extname(filePath);
            const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            res.end(data);
        });
    }
}

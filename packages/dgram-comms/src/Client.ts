import * as crypto from 'crypto';
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { DEFAULT_RECV_BUFFER_SIZE } from './constants.js';
import { decrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { Socket } from './Socket.js';
import type { DgramMessage, ManagerPath } from '@media-router/shared-types';
import { DgramWireMessageSchema, DgramDataSchema } from '@media-router/shared-types';

export interface ClientOptions {
    /** Client identifier — must match a key in the server's encryptionKeys. */
    clientId: string;
    /** One or more paths to the server (for redundancy). */
    paths: ManagerPath[];
    /** Shared encryption key (password). */
    encryptionKey: string;
    /** Connection timeout in ms (default 5000). */
    connectionTimeout?: number;
    /** Max missed keepalives before disconnect (default 3). */
    missedKeepaliveThreshold?: number;
    /** SO_RCVBUF for each path's UDP socket in bytes (default 4 MiB). Clamped to net.core.rmem_max. */
    recvBufferSize?: number;
}

interface PathState {
    path: ManagerPath;
    udpSocket: dgram.Socket;
    socket: Socket;
    transport: FragmentTransport;
    connected: boolean;
    lastReceived: number;
    rtt: number;
    alive: boolean;
    reconnectTimer: ReturnType<typeof setInterval> | null;
}

/**
 * dgram-comms multi-path UDP client.
 *
 * Connects to a server via 1–N UDP paths (for redundancy) and sends every
 * message on ALL paths, stamped with one shared sequence number per logical
 * message. The receiver's seq dedup is designed to collapse those bonded
 * copies — but note this is NOT exercised today: the server keeps a single
 * socket per clientID and each path's connect replaces the other's socket
 * (see Server.handleConnect), so only the current path's packets survive the
 * socketID lookup and reach dedup. True path bonding needs the server-side
 * multi-endpoint handshake fixed first; the shared-seq design is the right
 * groundwork for when it is.
 *
 * Emits:
 *   - `data` (topic, message) — received application message (deduped)
 *   - `connected` — at least one path connected
 *   - `disconnected` — all paths disconnected
 *   - `pathDown` (index) — a specific path went down
 *   - `pathUp` (index) — a specific path came back
 */
export class Client extends EventEmitter {
    private clientId: string;
    private encryptionKey: string;
    private connectionTimeout: number;
    private missedKeepaliveThreshold: number;
    private recvBufferSize: number;
    private pathStates: PathState[] = [];
    private destroyed = false;

    /** Monotonic sequence number; one per logical send, shared across all path copies. */
    private seq = 0;

    /**
     * Session nonce carried in every connect packet. Lets the server tell a
     * handshake RETRY (same Client re-sending connect because the reply was
     * lost or slow) from a REBIRTH (a new Client that happens to bind the same
     * ephemeral port, e.g. a crash-looping engine): retries must keep the
     * existing server socket, rebirths must replace it — otherwise the old
     * socket's seq-dedup table can silently eat the new session's messages.
     */
    private readonly sessionNonce = crypto.randomUUID();

    /** Whether at least one path is connected. */
    get connected(): boolean {
        return this.pathStates.some((p) => p.connected);
    }

    constructor(options: ClientOptions) {
        super();
        this.clientId = options.clientId;
        this.encryptionKey = options.encryptionKey;
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.recvBufferSize = options.recvBufferSize ?? DEFAULT_RECV_BUFFER_SIZE;

        // Set up each path
        for (const path of options.paths) {
            this.addPath(path);
        }
    }

    private addPath(path: ManagerPath): void {
        const index = this.pathStates.length;
        // Enlarge SO_RCVBUF to match the server; keeps bursty inbound (e.g. a
        // large guaranteed config push arriving as many fragments) from
        // overflowing the OS-default receive buffer. Clamped to rmem_max.
        const udpSocket = dgram.createSocket({
            type: 'udp4',
            recvBufferSize: this.recvBufferSize,
        });
        const transport = new FragmentTransport(udpSocket, {
            reassemblyTimeoutMs: this.connectionTimeout * 2,
        });

        // Listen for raw UDP packets on this path
        udpSocket.on('message', (msg, rinfo) => {
            this.onPacket(msg, index, rinfo);
        });

        udpSocket.on('error', (err) => {
            console.error(`[dgram-comms Client] path ${index} error: ${err.message}`);
        });

        // Bind (optionally to specific interface)
        if (path.bindAddress) {
            udpSocket.bind(0, path.bindAddress);
        }

        const pathState: PathState = {
            path,
            udpSocket,
            // socket: filled in below by buildPathSocket
            socket: undefined as unknown as Socket,
            transport,
            connected: false,
            lastReceived: 0,
            rtt: 0,
            alive: false,
            reconnectTimer: null,
        };

        this.pathStates.push(pathState);
        pathState.socket = this.buildPathSocket(index);

        // Send connect immediately, then retry every 1s until connected
        this.connectPath(index);
        setTimeout(() => this.connectPath(index), 200); // Quick retry in case first packet was lost
        setTimeout(() => this.connectPath(index), 500);

        pathState.reconnectTimer = setInterval(() => {
            if (!pathState.connected && !this.destroyed) {
                this.connectPath(index);
            }
        }, 1000); // Retry every 1s (not every 5s)
    }

    /**
     * Construct a fresh `Socket` for the given path and wire up its handlers.
     * Used both for initial path setup and to replace a destroyed Socket on
     * reconnect — without the replacement, the path-level reconnect would
     * call `send()` on the dead Socket forever (returns early when destroyed)
     * and the path could only recover when the higher-level (e.g.
     * ManagerConnection) rebuilt the whole Client. Reuses the path's UDP
     * socket and reassembler (those don't need a fresh OS handle).
     */
    private buildPathSocket(index: number): Socket {
        const ps = this.pathStates[index];
        const socket = new Socket({
            port: ps.path.port,
            address: ps.path.host,
            transport: ps.transport,
            isClient: true,
            clientID: this.clientId,
            encryptionKey: this.encryptionKey,
            connectionTimeout: this.connectionTimeout,
            missedKeepaliveThreshold: this.missedKeepaliveThreshold,
            onDisconnect: () => {
                const cur = this.pathStates[index];
                if (!cur) return;
                cur.connected = false;
                if (cur.alive) {
                    cur.alive = false;
                    this.emit('pathDown', index);
                }
                if (!this.connected) {
                    this.emit('disconnected');
                }
            },
        });

        // Handle connection (only emit once per connect cycle)
        socket.on('connected', () => {
            const cur = this.pathStates[index];
            if (!cur || cur.connected) return; // already-connected guard
            cur.connected = true;
            if (!cur.alive) {
                cur.alive = true;
                this.emit('pathUp', index);
            }
            this.emit('connected');
        });

        // Forward data events. Retransmit dedup happens by messageId in the
        // transport, and same-seq dedup in Socket.handleMessage would collapse
        // bonded multi-path copies too (once server-side bonding exists — see
        // the class doc); either way identical payloads are never wrongly dropped.
        socket.on('data', (topic: string, message: unknown) => {
            this.emit('data', topic, message);
        });

        return socket;
    }

    private connectPath(index: number): void {
        const ps = this.pathStates[index];
        if (!ps || ps.connected || this.destroyed) return;
        // Recreate the Socket if missed-keepalive watchdog destroyed it.
        // Reusing the dead Socket would have `send()` log "socket destroyed"
        // and drop the message — the path would never recover until the
        // higher-level reconnect rebuilt the whole Client.
        if (ps.socket.destroyed) {
            ps.socket.removeAllListeners();
            ps.socket = this.buildPathSocket(index);
        }
        // Send connect message
        ps.socket.send(null, this.sessionNonce, { type: 'connect' });
    }

    private onPacket(rawPacket: Buffer, pathIndex: number, rinfo: dgram.RemoteInfo): void {
        const ps = this.pathStates[pathIndex];
        if (!ps) return;

        ps.lastReceived = Date.now();

        // Reassemble fragments (and service fragment-level NACKs internally)
        const complete = ps.transport.receive(rawPacket, rinfo);
        if (!complete) return;

        // Parse and validate JSON envelope
        let raw: unknown;
        try {
            raw = JSON.parse(complete.toString());
        } catch {
            return;
        }
        const parsed = DgramWireMessageSchema.safeParse(raw);
        if (!parsed.success) {
            console.warn('[dgram-comms Client] Invalid message envelope — dropping');
            return;
        }
        const msg: DgramMessage = parsed.data as DgramMessage;

        // Decrypt if encrypted
        let data = msg.data;
        if (msg.iv && typeof data === 'string') {
            const decrypted = decrypt(data, msg.iv, this.encryptionKey);
            if (!decrypted) return;
            let decryptedJson: unknown;
            try {
                decryptedJson = JSON.parse(decrypted);
            } catch {
                return;
            }
            const dataResult = DgramDataSchema.safeParse(decryptedJson);
            if (!dataResult.success) {
                console.warn('[dgram-comms Client] Invalid decrypted data — dropping');
                return;
            }
            data = dataResult.data;
        }

        // Route to the path's socket
        ps.socket.handleMessage({ ...msg, data });
    }

    /**
     * Send a message to the server on ALL paths.
     */
    send(topic: string, message: unknown, options: { guaranteeDelivery?: boolean } = {}): void {
        if (this.destroyed) return;
        // One sequence number per logical message, shared across every path
        // copy so the server dedups the bonded duplicates by identity.
        this.seq += 1;
        const seq = this.seq;
        for (const ps of this.pathStates) {
            if (ps.connected) {
                ps.socket.send(topic, message, { ...options, seq });
            }
        }
    }

    /** Clean up all sockets and timers. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        for (const ps of this.pathStates) {
            if (ps.reconnectTimer) clearInterval(ps.reconnectTimer);
            ps.socket.destroy();
            ps.transport.destroy();
            ps.udpSocket.close();
        }

        this.pathStates = [];
        this.removeAllListeners();
    }
}

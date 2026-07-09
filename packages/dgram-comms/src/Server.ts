import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { DEFAULT_RECV_BUFFER_SIZE } from './constants.js';
import { decrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { Socket } from './Socket.js';
import type { DgramMessage } from '@media-router/shared-types';
import { DgramWireMessageSchema, DgramDataSchema } from '@media-router/shared-types';

export interface ServerOptions {
    /** UDP port to listen on (default 3000). */
    port?: number;
    /** Bind address (default "0.0.0.0"). */
    bindAddress?: string;
    /** Map of clientID → encryption password. */
    encryptionKeys?: Record<string, string>;
    /** Connection timeout in ms (default 5000). */
    connectionTimeout?: number;
    /** Max missed keepalives before disconnect (default 3). */
    missedKeepaliveThreshold?: number;
    /** Minimum ms between repeated "No key" / "Decryption failed" warnings per client (default 30_000). */
    rejectLogIntervalMs?: number;
    /** SO_RCVBUF for the listening UDP socket in bytes (default 4 MiB). Clamped to net.core.rmem_max. */
    recvBufferSize?: number;
}

/**
 * dgram-comms UDP server.
 *
 * Listens for client connections, validates credentials, manages Socket instances.
 * Emits 'connection' when a new client connects successfully.
 */
export class Server extends EventEmitter {
    private port: number;
    private bindAddress: string;
    private encryptionKeys: Record<string, string>;
    private connectionTimeout: number;
    private missedKeepaliveThreshold: number;

    private udpSocket: dgram.Socket;
    private transport: FragmentTransport;

    /** Connected sockets by socketID. */
    private sockets = new Map<string, Socket>();
    /** Map clientID → socketID for targeted sends. */
    private clientToSocket = new Map<string, string>();

    /**
     * Per-clientID rate limit for "No key" / "Decryption failed" warnings.
     * Stale or unauthorised clients can send at packet rate; without throttling
     * they fill the journal — seen in production where one stale client
     * produced 100+ warnings/sec until the upstream node was restarted.
     * Tracks the timestamp of the last log and how many were suppressed
     * since, so the next allowed log can include the suppressed count.
     */
    private rejectLogState = new Map<string, { lastLog: number; suppressed: number }>();
    private readonly rejectLogIntervalMs: number;

    constructor(options: ServerOptions = {}) {
        super();
        this.port = options.port ?? 3000;
        this.bindAddress = options.bindAddress ?? '0.0.0.0';
        this.encryptionKeys = { ...options.encryptionKeys };
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.rejectLogIntervalMs = options.rejectLogIntervalMs ?? 30_000;

        // Enlarge SO_RCVBUF so a fleet-wide reconnect storm (every engine
        // reconnecting at once after a manager restart) doesn't overflow the
        // OS-default ~208 KB receive buffer and drop packets as RcvbufErrors.
        this.udpSocket = dgram.createSocket({
            type: 'udp4',
            recvBufferSize: options.recvBufferSize ?? DEFAULT_RECV_BUFFER_SIZE,
        });
        this.transport = new FragmentTransport(this.udpSocket, {
            reassemblyTimeoutMs: this.connectionTimeout * 2,
        });

        this.udpSocket.on('error', (err) => {
            console.error(`[dgram-comms Server] error: ${err.message}`);
        });
    }

    /**
     * Throttle repeated rejection warnings for the same client. Returns the
     * suppressed count to inline in the log message, or `null` if the log
     * should be skipped entirely.
     */
    private claimRejectLog(clientID: string): { suppressed: number } | null {
        const now = Date.now();
        const state = this.rejectLogState.get(clientID);
        if (!state) {
            this.rejectLogState.set(clientID, { lastLog: now, suppressed: 0 });
            return { suppressed: 0 };
        }
        if (now - state.lastLog < this.rejectLogIntervalMs) {
            state.suppressed += 1;
            return null;
        }
        const suppressed = state.suppressed;
        state.lastLog = now;
        state.suppressed = 0;
        return { suppressed };
    }

    /** Start listening on the configured port. */
    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.udpSocket.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
            this.udpSocket.bind(this.port, this.bindAddress, () => {
                resolve();
            });
        });
    }

    /** Stop the server and disconnect all clients. */
    async stop(): Promise<void> {
        for (const socket of this.sockets.values()) {
            socket.destroy();
        }
        this.sockets.clear();
        this.clientToSocket.clear();
        this.rejectLogState.clear();
        this.transport.destroy();
        return new Promise((resolve) => {
            this.udpSocket.close(() => resolve());
        });
    }

    /**
     * Update encryption keys at runtime (e.g. when engines are added/removed).
     * Clears any throttle state for clients that now have a registered key —
     * if they were being rejected before and the operator just authorised
     * them, the next genuine rejection (e.g. wrong password) deserves a
     * fresh log line rather than being silently swallowed.
     */
    refreshEncryptionKeys(keys: Record<string, string>): void {
        this.encryptionKeys = { ...keys };
        for (const clientID of Object.keys(keys)) {
            this.rejectLogState.delete(clientID);
        }
    }

    /** Send a message to all connected clients. */
    broadcast(
        topic: string,
        message: unknown,
        options: { guaranteeDelivery?: boolean } = {},
    ): void {
        for (const socket of this.sockets.values()) {
            socket.send(topic, message, options);
        }
    }

    /** Send a message to a specific client by clientID. */
    sendTo(
        clientId: string,
        topic: string,
        message: unknown,
        options: { guaranteeDelivery?: boolean } = {},
    ): void {
        const socketId = this.clientToSocket.get(clientId);
        if (!socketId) {
            console.warn(`[dgram-comms Server] sendTo: no socket for client ${clientId}`);
            return;
        }
        const socket = this.sockets.get(socketId);
        if (!socket) {
            console.warn(
                `[dgram-comms Server] sendTo: socket ${socketId} not found for client ${clientId}`,
            );
            return;
        }
        socket.send(topic, message, options);
    }

    /** Check if a client is currently connected. */
    isClientOnline(clientId: string): boolean {
        const socketId = this.clientToSocket.get(clientId);
        if (!socketId) return false;
        const socket = this.sockets.get(socketId);
        return socket?.connected ?? false;
    }

    // ---- Packet handling -----------------------------------------------------

    private onPacket(rawPacket: Buffer, rinfo: dgram.RemoteInfo): void {
        // Reassemble fragments (and service fragment-level NACKs internally)
        const complete = this.transport.receive(rawPacket, rinfo);
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
            console.warn('[dgram-comms Server] Invalid message envelope — dropping');
            return;
        }
        const msg: DgramMessage = parsed.data as DgramMessage;

        // Decrypt data if encrypted
        const { type, clientID, iv } = msg;
        let data = msg.data;

        if (clientID && iv && typeof data === 'string') {
            const key = this.encryptionKeys[clientID];
            if (!key) {
                const claim = this.claimRejectLog(clientID);
                if (claim) {
                    const suffix = claim.suppressed > 0
                        ? ` (suppressed ${claim.suppressed} similar in last ${this.rejectLogIntervalMs}ms)`
                        : '';
                    console.warn(`[dgram-comms Server] No key for client: ${clientID}${suffix}`);
                }
                return;
            }
            const decrypted = decrypt(data, iv, key);
            if (!decrypted) {
                const claim = this.claimRejectLog(clientID);
                if (claim) {
                    const suffix = claim.suppressed > 0
                        ? ` (suppressed ${claim.suppressed} similar in last ${this.rejectLogIntervalMs}ms)`
                        : '';
                    console.warn(
                        `[dgram-comms Server] Decryption failed for client: ${clientID}${suffix}`,
                    );
                }
                return;
            }
            let decryptedJson: unknown;
            try {
                decryptedJson = JSON.parse(decrypted);
            } catch {
                return;
            }
            const dataResult = DgramDataSchema.safeParse(decryptedJson);
            if (!dataResult.success) {
                console.warn(
                    `[dgram-comms Server] Invalid decrypted data from ${clientID} — dropping`,
                );
                return;
            }
            data = dataResult.data;
        }

        // Route by message type
        switch (type) {
            case 'connect':
                console.log(
                    `[dgram-comms Server] connect from ${clientID} (${rinfo.address}:${rinfo.port}), has key: ${!!this.encryptionKeys[clientID]}`,
                );
                this.handleConnect(clientID, data, rinfo);
                break;

            case 'keepAlive': {
                const socket = this.getSocketByDataSocketID(data?.socketID as string);
                if (socket) {
                    socket.updateRemote(rinfo.port, rinfo.address);
                    socket.resetKeepalive();
                }
                break;
            }

            case 'ack': {
                const socket = this.getSocketByDataSocketID(data?.socketID as string);
                if (socket) {
                    socket.updateRemote(rinfo.port, rinfo.address);
                    socket.handleMessage({ ...msg, data });
                }
                break;
            }

            case 'data': {
                const socket = this.getSocketByDataSocketID(data?.socketID as string);
                if (socket) {
                    socket.updateRemote(rinfo.port, rinfo.address);
                    socket.handleMessage({ ...msg, data });
                }
                break;
            }
        }
    }

    private handleConnect(
        clientID: string,
        data: DgramMessage['data'],
        rinfo: dgram.RemoteInfo,
    ): void {
        // Validate client has a registered encryption key
        if (!this.encryptionKeys[clientID]) return;

        // Client-generated session nonce (undefined for older clients).
        const nonce = typeof data?.message === 'string' ? data.message : undefined;

        const existingSocketId = this.clientToSocket.get(clientID);
        if (existingSocketId) {
            const existing = this.sockets.get(existingSocketId);
            if (existing) {
                // A connect from the SAME endpoint AND same session nonce is a
                // handshake retry (the client fires connects at 0/200/500ms and
                // on a high-RTT link the retry always beats the first reply),
                // NOT a new session. Replacing the socket here minted a new
                // socketID per retry and the client ended up on whichever
                // reply landed last — a coin flip against the manager's live
                // socket, after which every packet it sent was dropped as
                // unknown-socketID (measured on the NO-BR gate, RTT ~350ms).
                // Re-ack with the SAME socketID instead.
                //
                // The nonce guards the endpoint check against a reborn client
                // (crash-loop) landing on the same ephemeral port: reusing the
                // old socket there would let its seq-dedup table silently eat
                // the new session's early messages. Different nonce ⇒ rebirth.
                if (
                    existing.remoteAddress === rinfo.address &&
                    existing.remotePort === rinfo.port &&
                    existing.connectNonce === nonce
                ) {
                    existing.resetKeepalive();
                    existing.send('connected', existing.socketID, {
                        type: 'connected',
                        guaranteeDelivery: true,
                    });
                    return;
                }
                // Different endpoint or nonce → genuine reconnect (new client):
                // tear down the old session and build a fresh one.
                console.log(`[dgram-comms Server] ${clientID} reconnecting — replacing old socket`);
                existing.destroy();
                this.sockets.delete(existingSocketId);
                this.clientToSocket.delete(clientID);
            }
        }

        // Create new socket for this client
        const socket = new Socket({
            port: rinfo.port,
            address: rinfo.address,
            transport: this.transport,
            isClient: false,
            clientID,
            encryptionKey: this.encryptionKeys[clientID],
            connectionTimeout: this.connectionTimeout,
            missedKeepaliveThreshold: this.missedKeepaliveThreshold,
            onDisconnect: (socketID) => {
                this.sockets.delete(socketID);
                this.clientToSocket.delete(clientID);
                this.emit('disconnection', clientID);
            },
        });

        socket.connectNonce = nonce;
        this.sockets.set(socket.socketID, socket);
        this.clientToSocket.set(clientID, socket.socketID);

        // Confirm connection
        socket.send('connected', socket.socketID, {
            type: 'connected',
            guaranteeDelivery: true,
        });

        socket.connected = true;
        socket.markConnected();
        this.emit('connection', socket, clientID);
    }

    private getSocketByDataSocketID(socketID: string | undefined): Socket | undefined {
        if (!socketID) return undefined;
        return this.sockets.get(socketID);
    }
}

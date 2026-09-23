import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as os from 'os';
import { EventEmitter } from 'events';
import { DEFAULT_RECV_BUFFER_SIZE } from './constants.js';
import { decrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { SeqDedup } from './SeqDedup.js';
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
 * First non-internal IPv4 address of a named interface, or undefined. Node's
 * dgram has no SO_BINDTODEVICE, so "bind to eth1" means "bind to eth1's
 * current address" — resolved when the path socket is created (the Client is
 * rebuilt on every full reconnect, so a DHCP change is picked up then).
 */
export function resolveInterfaceAddress(
    name: string,
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | undefined {
    const addrs = interfaces[name] ?? [];
    return addrs.find((a) => a.family === 'IPv4' && !a.internal)?.address;
}

/**
 * dgram-comms multi-path UDP client.
 *
 * Connects to a server via 1–N UDP paths (for redundancy). Every path
 * presents the same session nonce, so the server binds them all to ONE
 * session (same socketID) and fans its replies out to every live path;
 * the client sends every message on ALL connected paths, stamped with one
 * shared sequence number per logical message. A dedup table shared across
 * the path Sockets collapses the bonded copies in both directions. A path
 * that dies is re-handshaken on its own 1s retry while the others carry the
 * session — the higher level only sees `disconnected` when every path is gone.
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

    /** One receive-side dedup table for every path — a copy that already landed on another path is dropped. */
    private readonly dedup = new SeqDedup();

    /** ackIDs unique across paths: the server's acks reach every path, so path A must not own path B's number. */
    private ackCounter = 0;

    /**
     * Session nonce carried in every connect packet. Lets the server tell a
     * handshake RETRY or an ADDITIONAL PATH (same Client, same session) from a
     * REBIRTH (a new Client that happens to bind the same ephemeral port, e.g.
     * a crash-looping engine): the former join the existing server socket,
     * the latter must replace it — otherwise the old socket's seq-dedup table
     * can silently eat the new session's messages.
     */
    private readonly sessionNonce = crypto.randomUUID();

    /** Whether at least one path is connected. */
    get connected(): boolean {
        return this.pathStates.some((p) => p.connected);
    }

    /** Indices of the paths currently connected. */
    get connectedPaths(): number[] {
        return this.pathStates.flatMap((p, i) => (p.connected ? [i] : []));
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

        // Bind to a specific source address when asked: explicit address, or
        // the named interface's current address. Unbound ⇒ OS routing picks.
        const bindAddress =
            path.bindAddress ??
            (path.bindInterface ? resolveInterfaceAddress(path.bindInterface) : undefined);
        if (path.bindInterface && !path.bindAddress && !bindAddress) {
            console.warn(
                `[dgram-comms Client] path ${index}: interface ${path.bindInterface} has no IPv4 address — leaving unbound`,
            );
        }
        if (bindAddress) {
            udpSocket.bind(0, bindAddress);
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
            seqDedup: this.dedup,
            nextAckId: () => ++this.ackCounter,
            onDisconnect: () => {
                if (this.destroyed) return; // destroy() is silent by contract
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
        // transport; the shared (session, seq) dedup in Socket.handleMessage
        // collapses the server's bonded multi-path copies, so each logical
        // message reaches the application once whichever path delivered it.
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
        this.dedup.clear();
        this.removeAllListeners();
    }
}

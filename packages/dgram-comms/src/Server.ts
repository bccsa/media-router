import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { DEFAULT_RECV_BUFFER_SIZE } from './constants.js';
import { decrypt, encrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { Socket, type EndpointInfo } from './Socket.js';
import type { DgramMessage, DgramListener } from '@media-router/shared-types';
import { DgramWireMessageSchema, DgramDataSchema } from '@media-router/shared-types';

/** One UDP socket the server listens on — the shared `DgramListener` shape. */
export type ListenerSpec = DgramListener;

export interface ServerOptions {
    /** UDP port to listen on (default 3000). Shorthand for a single listener. */
    port?: number;
    /** Bind address (default "0.0.0.0"). Shorthand for a single listener. */
    bindAddress?: string;
    /**
     * Listen on several port/address pairs at once so engines can reach the
     * same session over more than one network path. Overrides `port` /
     * `bindAddress` when given. At least one entry.
     */
    listeners?: ListenerSpec[];
    /** Map of clientID → encryption password. */
    encryptionKeys?: Record<string, string>;
    /** Connection timeout in ms (default 5000). */
    connectionTimeout?: number;
    /** Max missed keepalives before disconnect (default 3). */
    missedKeepaliveThreshold?: number;
    /** Minimum ms between repeated "No key" / "Decryption failed" warnings per client (default 30_000). */
    rejectLogIntervalMs?: number;
    /** SO_RCVBUF for each listening UDP socket in bytes (default 4 MiB). Clamped to net.core.rmem_max. */
    recvBufferSize?: number;
}

interface Listener {
    spec: ListenerSpec;
    udpSocket: dgram.Socket;
    transport: FragmentTransport;
    closed: boolean;
}

/** Bound port for logs (the spec's port when unbound or ephemeral-unbound). */
function listenerPort(l: Listener): number {
    try {
        return l.udpSocket.address().port;
    } catch {
        return l.spec.port;
    }
}

/**
 * dgram-comms UDP server.
 *
 * Listens on one or more UDP sockets, validates credentials, manages Socket
 * instances. One Socket (session) per clientID: a client that connects over
 * several paths — different source sockets, possibly different listeners —
 * joins the SAME session by presenting the same session nonce, and every
 * server→client message is fanned out to all of that session's live
 * endpoints. Emits 'connection' when a new client connects successfully.
 */
export class Server extends EventEmitter {
    private port: number;
    private bindAddress: string;
    private encryptionKeys: Record<string, string>;
    private connectionTimeout: number;
    private missedKeepaliveThreshold: number;

    private udpListeners: Listener[] = [];

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

    /** Per-endpoint timestamp of the last 'reset' sent (rate limiting). */
    private resetLastSent = new Map<string, number>();
    private static readonly RESET_INTERVAL_MS = 2000;
    private static readonly RESET_MAP_MAX = 1024;

    constructor(options: ServerOptions = {}) {
        super();
        const specs: ListenerSpec[] = options.listeners?.length
            ? options.listeners
            : [{ port: options.port ?? 3000, bindAddress: options.bindAddress }];
        this.port = specs[0].port;
        this.bindAddress = specs[0].bindAddress ?? '0.0.0.0';
        this.encryptionKeys = { ...options.encryptionKeys };
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.rejectLogIntervalMs = options.rejectLogIntervalMs ?? 30_000;

        for (const spec of specs) {
            // Enlarge SO_RCVBUF so a fleet-wide reconnect storm (every engine
            // reconnecting at once after a manager restart) doesn't overflow the
            // OS-default ~208 KB receive buffer and drop packets as RcvbufErrors.
            const udpSocket = dgram.createSocket({
                type: 'udp4',
                recvBufferSize: options.recvBufferSize ?? DEFAULT_RECV_BUFFER_SIZE,
            });
            const transport = new FragmentTransport(udpSocket, {
                reassemblyTimeoutMs: this.connectionTimeout * 2,
            });
            udpSocket.on('error', (err) => {
                console.error(
                    `[dgram-comms Server] listener ${spec.bindAddress ?? '0.0.0.0'}:${spec.port} error: ${err.message}`,
                );
            });
            this.udpListeners.push({ spec: { ...spec }, udpSocket, transport, closed: false });
        }
    }

    /** First listener's UDP socket (single-listener callers and tests). */
    private get udpSocket(): dgram.Socket {
        return this.udpListeners[0].udpSocket;
    }

    /** First listener's transport (single-listener callers and tests). */
    private get transport(): FragmentTransport {
        return this.udpListeners[0].transport;
    }

    /** The listeners this server was built with. */
    get listenerSpecs(): ListenerSpec[] {
        return this.udpListeners.map((l) => ({ ...l.spec }));
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

    /**
     * Start listening on every configured listener. Rejects if any bind fails —
     * and then closes the ones that did bind, so a half-started server never
     * lingers holding ports. The instance is not restartable after that.
     */
    async start(): Promise<void> {
        try {
            await Promise.all(this.udpListeners.map((l) => this.bindListener(l)));
        } catch (err) {
            await this.closeListeners();
            throw err;
        }
    }

    /**
     * Probe whether `spec` can be bound right now (bind + close a throwaway
     * socket). Lets a caller reject a bad listener set BEFORE tearing down a
     * live server. Not a guarantee — the port can be taken in between.
     */
    static canBind(spec: ListenerSpec): Promise<void> {
        return new Promise((resolve, reject) => {
            const probe = dgram.createSocket('udp4');
            probe.once('error', (err) => {
                probe.close();
                reject(err);
            });
            probe.bind(spec.port, spec.bindAddress ?? '0.0.0.0', () => probe.close(resolve));
        });
    }

    private async closeListeners(): Promise<void> {
        await Promise.all(
            this.udpListeners.map((l) => {
                l.transport.destroy();
                if (l.closed) return Promise.resolve();
                l.closed = true;
                return new Promise<void>((resolve) => {
                    try {
                        l.udpSocket.close(() => resolve());
                    } catch {
                        resolve();
                    }
                });
            }),
        );
    }

    private bindListener(l: Listener): Promise<void> {
        return new Promise((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            l.udpSocket.once('error', onError);
            l.udpSocket.on('message', (msg, rinfo) => this.onPacket(msg, rinfo, l));
            l.udpSocket.bind(l.spec.port, l.spec.bindAddress ?? '0.0.0.0', () => {
                l.udpSocket.off('error', onError);
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
        this.resetLastSent.clear();
        await this.closeListeners();
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

    /** Live endpoint keys (`address:port`) of a client's session; empty when offline. */
    clientEndpoints(clientId: string): string[] {
        return this.clientSocket(clientId)?.endpointKeys ?? [];
    }

    /** Live endpoints of a client's session with the listener port each arrived on. */
    clientEndpointInfo(clientId: string): EndpointInfo[] {
        return this.clientSocket(clientId)?.endpointInfo ?? [];
    }

    private clientSocket(clientId: string): Socket | undefined {
        const socketId = this.clientToSocket.get(clientId);
        return socketId ? this.sockets.get(socketId) : undefined;
    }

    // ---- Packet handling -----------------------------------------------------

    private onPacket(
        rawPacket: Buffer,
        rinfo: dgram.RemoteInfo,
        listener: Listener = this.udpListeners[0],
    ): void {
        // Reassemble fragments (and service fragment-level NACKs internally)
        const complete = listener.transport.receive(rawPacket, rinfo);
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
                    `[dgram-comms Server] connect from ${clientID} (${rinfo.address}:${rinfo.port} → :${listenerPort(listener)}), has key: ${!!this.encryptionKeys[clientID]}`,
                );
                this.handleConnect(clientID, data, rinfo, listener);
                break;

            case 'keepAlive':
            case 'ack':
            case 'data': {
                const socket = this.getSocketByDataSocketID(data?.socketID as string);
                if (!socket) {
                    this.maybeSendReset(clientID, data?.socketID as string | undefined, rinfo, listener);
                    break;
                }
                // The packet named a live socketID (a server-issued UUID an
                // off-path sender can't know — the same trust the old
                // follow-the-sender NAT update relied on), so its source is
                // one of this session's endpoints: add or refresh it. A NAT
                // rebind shows up as a new endpoint; the stale one ages out.
                socket.touchEndpoint(
                    listener.transport,
                    rinfo.port,
                    rinfo.address,
                    listenerPort(listener),
                );
                if (type === 'keepAlive') socket.resetKeepalive();
                else socket.handleMessage({ ...msg, data });
                break;
            }
        }
    }

    private handleConnect(
        clientID: string,
        data: DgramMessage['data'],
        rinfo: dgram.RemoteInfo,
        listener: Listener = this.udpListeners[0],
    ): void {
        // Validate client has a registered encryption key
        if (!this.encryptionKeys[clientID]) return;

        // Client-generated session nonce (undefined for older clients).
        const nonce = typeof data?.message === 'string' ? data.message : undefined;

        const existingSocketId = this.clientToSocket.get(clientID);
        if (existingSocketId) {
            const existing = this.sockets.get(existingSocketId);
            if (existing) {
                // Same session nonce ⇒ same session: either a handshake RETRY
                // (the client fires connects at 0/200/500ms and on a high-RTT
                // link the retry beats the first reply) or an ADDITIONAL PATH
                // (another client socket, maybe via another listener). Both
                // must land on the existing socket: replacing it minted a new
                // socketID per connect and the client ended up on whichever
                // reply landed last — a coin flip against the manager's live
                // socket, after which every packet it sent was dropped as
                // unknown-socketID (measured on the NO-BR gate, RTT ~350ms);
                // with two paths the two connects fought forever.
                //
                // The nonce guards against a reborn client (crash-loop)
                // landing on the same ephemeral port: reusing the old socket
                // there would let its seq-dedup table silently eat the new
                // session's early messages. Different nonce ⇒ rebirth. A
                // nonce-less (older) client only counts as a retry from the
                // endpoint we already know — a new endpoint is a rebirth.
                const sameEndpoint = existing.hasEndpoint(rinfo.address, rinfo.port);
                if (existing.connectNonce === nonce && (sameEndpoint || nonce !== undefined)) {
                    const added = existing.touchEndpoint(
                        listener.transport,
                        rinfo.port,
                        rinfo.address,
                        listenerPort(listener),
                    );
                    if (added) {
                        console.log(
                            `[dgram-comms Server] ${clientID} joined path ${rinfo.address}:${rinfo.port} → :${listenerPort(listener)} (${existing.endpointKeys.length} paths)`,
                        );
                    }
                    existing.resetKeepalive();
                    // Answer the path that asked; the other paths already have it.
                    existing.sendToEndpoint(rinfo.address, rinfo.port, 'connected', existing.socketID, {
                        type: 'connected',
                        guaranteeDelivery: true,
                    });
                    return;
                }
                // Different nonce (or unknown endpoint from a nonce-less
                // client) → genuine reconnect: tear down the old session and
                // build a fresh one.
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
            transport: listener.transport,
            localPort: listenerPort(listener),
            isClient: false,
            clientID,
            encryptionKey: this.encryptionKeys[clientID],
            connectionTimeout: this.connectionTimeout,
            missedKeepaliveThreshold: this.missedKeepaliveThreshold,
            onDisconnect: (socketID) => {
                this.sockets.delete(socketID);
                // Only unmap (and report offline) if the mapping still points
                // at THIS socket — a late-dying replaced socket must not mark
                // the live replacement session offline.
                if (this.clientToSocket.get(clientID) === socketID) {
                    this.clientToSocket.delete(clientID);
                    this.emit('disconnection', clientID);
                }
            },
        });
        socket.on('pathDown', (key: string) => {
            console.log(`[dgram-comms Server] ${clientID} path ${key} down (${socket.endpointKeys.length} left)`);
            this.emit('pathDown', clientID, key);
        });
        socket.on('pathUp', (key: string) => this.emit('pathUp', clientID, key));

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

    /**
     * Encrypted, rate-limited "your session is dead" hint (TCP-RST analogue).
     * Without it a client whose session the server timed out keeps sending on
     * the forgotten socketID — silently dropped — until its own watchdog fires.
     *
     * Safe to send on unauthenticated triggers (keepAlive/ack envelopes are
     * plaintext): the payload is encrypted with the claimed clientID's key and
     * names the unknown socketID, and the client only acts if it decrypts AND
     * matches its CURRENT socketID — a server-issued UUID an off-path attacker
     * can't know. If the server truly doesn't know the socketID, acting on the
     * reset is correct behavior regardless of who triggered it.
     */
    private maybeSendReset(
        clientID: string,
        socketID: string | undefined,
        rinfo: dgram.RemoteInfo,
        listener: Listener = this.udpListeners[0],
    ): void {
        if (!socketID) return;
        const key = this.encryptionKeys[clientID];
        if (!key) return;

        const endpoint = `${rinfo.address}:${rinfo.port}`;
        const now = Date.now();
        const last = this.resetLastSent.get(endpoint) ?? 0;
        if (now - last < Server.RESET_INTERVAL_MS) return;
        // Opportunistic eviction — stale endpoints (dead NAT mappings) would
        // otherwise accumulate one small entry each, forever.
        if (this.resetLastSent.size >= Server.RESET_MAP_MAX) {
            for (const [ep, ts] of this.resetLastSent) {
                if (now - ts >= Server.RESET_INTERVAL_MS) this.resetLastSent.delete(ep);
            }
        }
        this.resetLastSent.set(endpoint, now);

        const encrypted = encrypt(JSON.stringify({ socketID }), key);
        const envelope = {
            type: 'reset',
            clientID,
            iv: encrypted.iv,
            data: encrypted.data,
        };
        listener.transport.send(
            Buffer.from(JSON.stringify(envelope)),
            rinfo.port,
            rinfo.address,
            false,
        );
    }
}

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { encrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { ReliableDelivery, type SentCopy } from './ReliableDelivery.js';
import { SeqDedup } from './SeqDedup.js';
import type { DgramMessage } from '@media-router/shared-types';

export interface SocketOptions {
    /** Remote port. */
    port: number;
    /** Remote address. */
    address: string;
    /** Fragment transport (owns the udp socket + fragment-level reliability) the first endpoint is reached through. */
    transport: FragmentTransport;
    /** Our listener port the first endpoint reaches us on (server side). */
    localPort?: number;
    /** Whether this is the client side of the connection. */
    isClient?: boolean;
    /** Client identifier (for encryption key lookup). */
    clientID?: string;
    /** Encryption password. */
    encryptionKey?: string;
    /** Connection timeout in ms (default 5000). */
    connectionTimeout?: number;
    /** Max missed keepalives before disconnect (default 3). */
    missedKeepaliveThreshold?: number;
    /** Called when this socket disconnects. */
    onDisconnect?: (socketID: string) => void;
    /** Receive-side dedup table. A multi-path Client shares one across its path Sockets. */
    seqDedup?: SeqDedup;
    /** Shared ackID source. Server acks fan out to every path, so a Client's path Sockets must never reuse an ackID. */
    nextAckId?: () => number;
}

/** One remote address a session is reachable at, and the transport that reaches it. */
export interface Endpoint {
    key: string;
    transport: FragmentTransport;
    address: string;
    port: number;
    /** Our own listener port this endpoint reaches us on (0 when unknown). */
    localPort: number;
    lastSeen: number;
}

/** Endpoint facts safe to hand to callers (no transport handle). */
export interface EndpointInfo {
    address: string;
    port: number;
    localPort: number;
    lastSeen: number;
}

export function endpointKey(address: string, port: number): string {
    return `${address}:${port}`;
}

/**
 * A single bidirectional session.
 *
 * Handles the full pipeline:
 *   send: JSON → encrypt → fragment → UDP
 *   recv: UDP → reassemble → decrypt → JSON → emit(topic, message)
 *
 * Provides guaranteed delivery via ACK/retry with exponential backoff.
 * Sends keepalive heartbeats to detect connection loss.
 *
 * A server-side Socket may span several ENDPOINTS — one per path the client
 * reaches us on (different client sockets, possibly via different listeners).
 * Every send fans out to all live endpoints with one shared seq so the
 * client's dedup collapses the copies; an endpoint that stops being heard
 * from is pruned (`pathDown`) while the session lives on through the rest.
 * A client-side Socket always has exactly one endpoint (its path).
 */
export class Socket extends EventEmitter {
    socketID: string;
    connected = false;
    readonly isClient: boolean;
    readonly clientID: string;
    /** Server-side: the client's session nonce from the connect payload —
     *  distinguishes handshake retries / additional paths from a reborn client
     *  (see Server.handleConnect). Undefined for older clients. */
    connectNonce: string | undefined;

    private endpoints = new Map<string, Endpoint>();
    private encryptionKey: string | undefined;
    private connectionTimeout: number;
    private missedKeepaliveThreshold: number;
    private onDisconnectCb: ((socketID: string) => void) | undefined;

    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private keepAliveTime = Date.now();
    private missedKeepalives = 0;
    private _destroyed = false;

    /** True after `disconnect()` ran — no further sends or events should occur. */
    get destroyed(): boolean {
        return this._destroyed;
    }

    /** Guaranteed-delivery bookkeeping (ackIDs, fallback resend, release-on-ACK). */
    private reliable: ReliableDelivery;

    /** Monotonic sequence number stamped on outgoing data messages. */
    private seqCounter = 0;

    /** (session, seq) dedup — own table unless the Client shared one across its paths. */
    private readonly dedup: SeqDedup;
    private readonly ownsDedup: boolean;

    constructor(options: SocketOptions) {
        super();
        this.isClient = options.isClient ?? false;
        this.clientID = options.clientID ?? '';
        this.encryptionKey = options.encryptionKey;
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.onDisconnectCb = options.onDisconnect;
        this.ownsDedup = !options.seqDedup;
        this.dedup = options.seqDedup ?? new SeqDedup();
        this.touchEndpoint(
            options.transport,
            options.port,
            options.address,
            options.localPort ?? 0,
        );
        this.reliable = new ReliableDelivery(
            (key) => {
                const ep = this.endpoints.get(key);
                return ep ? { port: ep.port, address: ep.address } : undefined;
            },
            (info) => this.emit('ackTimeout', info),
            () => this.destroyed,
            options.nextAckId,
        );

        // Client sockets get their socketID assigned by the server
        this.socketID = this.isClient ? '' : crypto.randomUUID();

        this.startKeepalive();
    }

    // ---- Endpoints -----------------------------------------------------------

    /**
     * Record that the peer was just heard from at `address:port` via
     * `transport`. Adds the endpoint (emits `pathUp`) or refreshes it. Also
     * covers NAT rebinds: the new mapping shows up as a fresh endpoint and the
     * stale one ages out. Returns true when the endpoint is new.
     */
    touchEndpoint(
        transport: FragmentTransport,
        port: number,
        address: string,
        localPort = 0,
    ): boolean {
        const key = endpointKey(address, port);
        const existing = this.endpoints.get(key);
        const now = Date.now();
        if (existing) {
            existing.lastSeen = now;
            existing.transport = transport;
            if (localPort) existing.localPort = localPort;
            return false;
        }
        this.endpoints.set(key, { key, transport, address, port, localPort, lastSeen: now });
        if (this.endpoints.size > 1) this.emit('pathUp', key);
        return true;
    }

    /** True if `address:port` is one of this session's live endpoints. */
    hasEndpoint(address: string, port: number): boolean {
        return this.endpoints.has(endpointKey(address, port));
    }

    /** Live endpoint keys (`address:port`). */
    get endpointKeys(): string[] {
        return [...this.endpoints.keys()];
    }

    /** Live endpoints with the listener port each one reaches us on. */
    get endpointInfo(): EndpointInfo[] {
        return [...this.endpoints.values()].map(({ address, port, localPort, lastSeen }) => ({
            address,
            port,
            localPort,
            lastSeen,
        }));
    }

    /** Most recently heard-from endpoint. */
    private primaryEndpoint(): Endpoint {
        let best: Endpoint | undefined;
        for (const ep of this.endpoints.values()) {
            if (!best || ep.lastSeen > best.lastSeen) best = ep;
        }
        return best as Endpoint;
    }

    /** Current primary remote endpoint. */
    get remotePort(): number {
        return this.primaryEndpoint().port;
    }
    get remoteAddress(): string {
        return this.primaryEndpoint().address;
    }

    /**
     * Drop endpoints silent for a whole keepalive death window. Never prunes
     * the last one — session death is the watchdog's call, not this one's.
     */
    private pruneEndpoints(now: number): void {
        if (this.endpoints.size <= 1) return;
        const deadline = this.connectionTimeout * this.missedKeepaliveThreshold;
        for (const ep of [...this.endpoints.values()]) {
            if (this.endpoints.size <= 1) break;
            if (now - ep.lastSeen > deadline) {
                this.endpoints.delete(ep.key);
                this.emit('pathDown', ep.key);
            }
        }
    }

    // ---- Send ---------------------------------------------------------------

    /**
     * Send a message to the remote side (every live endpoint).
     * @param topic Application-level topic string.
     * @param message Arbitrary JSON-serialisable payload.
     * @param options `guaranteeDelivery` to enable ACK/retry.
     */
    send(
        topic: string | null,
        message: unknown,
        options: {
            type?: DgramMessage['type'];
            guaranteeDelivery?: boolean;
            ackID?: number;
            /** Shared sequence number (set by the multi-path Client so every path copy dedups as one). */
            seq?: number;
        } = {},
    ): void {
        if (this.destroyed) {
            console.warn(
                `[dgram-comms Socket] send: socket destroyed, dropping message topic=${topic}`,
            );
            return;
        }
        this._send(topic, message, options);
    }

    /**
     * Send to ONE endpoint only — the handshake reply must answer the path
     * that asked, not every path the session is known on.
     */
    sendToEndpoint(
        address: string,
        port: number,
        topic: string | null,
        message: unknown,
        options: { type?: DgramMessage['type']; guaranteeDelivery?: boolean } = {},
    ): void {
        if (this.destroyed) return;
        const ep = this.endpoints.get(endpointKey(address, port));
        if (!ep) return;
        this._send(topic, message, options, ep);
    }

    private _send(
        topic: string | null,
        message: unknown,
        options: {
            type?: DgramMessage['type'];
            guaranteeDelivery?: boolean;
            ackID?: number;
            seq?: number;
        },
        only?: Endpoint,
    ): void {
        // Assign ackID for guaranteed delivery
        if (!options.ackID && options.guaranteeDelivery) {
            options.ackID = this.reliable.nextAckId();
        }

        const msgType = options.type ?? 'data';

        // Assign a monotonic sequence number to data messages so the receiver
        // dedups by identity. Multi-path copies and retransmits carry the same
        // seq: the Client passes a shared seq for its bonded path copies, and
        // retransmits reuse it via the preserved options object. Only data
        // messages need it — keepalive/ack/connect are idempotent.
        if (msgType === 'data' && options.seq === undefined) {
            this.seqCounter += 1;
            options.seq = this.seqCounter;
        }

        const data: DgramMessage['data'] = {
            topic: topic ?? undefined,
            message,
            ackID: options.ackID,
            socketID: this.socketID,
        };

        // Encrypt if we have a key and this is a data/connect message
        let envelope: DgramMessage;

        if (this.clientID && this.encryptionKey && (msgType === 'data' || msgType === 'connect')) {
            const encrypted = encrypt(JSON.stringify(data), this.encryptionKey);
            envelope = {
                type: msgType,
                clientID: this.clientID,
                iv: encrypted.iv,
                seq: options.seq,
                data: encrypted.data as unknown as DgramMessage['data'],
            };
        } else {
            envelope = {
                type: msgType,
                clientID: this.clientID,
                seq: options.seq,
                data,
            };
        }

        const buf = Buffer.from(JSON.stringify(envelope));
        const reliable = !!options.guaranteeDelivery;
        const targets = only ? [only] : [...this.endpoints.values()];
        const copies: SentCopy[] = targets.map((ep) => ({
            transport: ep.transport,
            messageId: ep.transport.send(buf, ep.port, ep.address, reliable),
            endpointKey: ep.key,
        }));

        if (reliable && options.ackID !== undefined) {
            this.reliable.track(options.ackID, copies, topic ?? undefined);
        }
    }

    // ---- Receive -------------------------------------------------------------

    /**
     * Called by Server/Client when a reassembled, parsed message arrives for this socket.
     *
     * Bails out on destroyed sockets: an in-flight UDP packet may arrive after
     * `disconnect()` (kernel buffer, server-restart 'connected' reply) and
     * without this guard it would re-emit `connected` from a dead Socket,
     * leaving the higher level thinking it's online while every subsequent
     * `send()` drops with "socket destroyed".
     */
    handleMessage(msg: DgramMessage): void {
        if (this._destroyed) return;
        this.resetKeepalive();

        switch (msg.type) {
            case 'keepAlive':
                break;

            case 'ack':
                if (msg.data?.ackID !== undefined) {
                    this.reliable.ack(msg.data.ackID);
                }
                break;

            case 'connected':
                if (this.isClient && msg.data?.socketID) {
                    this.socketID = msg.data.socketID as string;
                }
                // ACK the handshake — the server sends 'connected' guaranteed and
                // resends until acknowledged. Ack BEFORE the already-connected
                // guard so retransmitted copies are re-ACKed too (previously this
                // was never acked at all and every handshake hit GIVE-UP).
                if (msg.data?.ackID !== undefined) {
                    this.sendAck(msg.data.ackID);
                }
                if (this.connected) break; // retransmit of a handshake we processed
                this.connected = true;
                this.hasEverConnected = true;
                this.missedKeepalives = 0;
                this.keepAliveTime = Date.now();
                this.emit('connected');
                break;

            case 'data': {
                // ACK first — even duplicates must be acked, or the sender
                // keeps retransmitting a message we already have.
                if (msg.data?.ackID !== undefined) {
                    this.sendAck(msg.data.ackID);
                }
                // Dedup by (sending session, seq). Multi-path copies and
                // retransmits share both; genuinely distinct messages always get
                // distinct seqs, so identical payloads are never wrongly dropped —
                // the old receive-time content hash did exactly that when latency
                // bunched packets into one 500ms window.
                if (msg.seq !== undefined) {
                    if (this.dedup.isDuplicate(msg.data?.socketID as string | undefined, msg.seq)) {
                        break;
                    }
                }
                const topic = msg.data?.topic;
                if (topic) {
                    this.emit(topic, msg.data.message);
                    // Also emit generic 'data' event for forwarding
                    this.emit('data', topic, msg.data.message);
                }
                break;
            }

            case 'connect':
                // Handled by Server, not Socket
                break;

            case 'reset':
                // The server no longer recognises our session (it timed out
                // server-side while we still think we're connected). Only act
                // if the encrypted payload names OUR current socketID — stale
                // duplicates and spoofed triggers are ignored. The socketID is
                // a server-issued UUID an off-path attacker can't know, and
                // the payload only decrypts with our shared key.
                if (this.isClient && this.connected && msg.data?.socketID === this.socketID) {
                    this.disconnect();
                }
                break;
        }
    }

    private sendAck(ackID: number): void {
        this._send(null, null, { type: 'ack', ackID });
    }

    // ---- Keepalive -----------------------------------------------------------

    private startKeepalive(): void {
        if (this.keepAliveTimer) return;
        this.watchdogIntervalMs = Math.max(this.connectionTimeout / 4, 500);
        this.lastWatchdogTick = Date.now();
        this.keepAliveTimer = setInterval(() => {
            this.connectionWatchdog();
        }, this.watchdogIntervalMs);
    }

    private hasEverConnected = false;
    private watchdogIntervalMs = 0;
    private lastWatchdogTick = 0;

    private connectionWatchdog(): void {
        if (this.destroyed) return;

        const now = Date.now();
        const late = now - this.lastWatchdogTick > this.watchdogIntervalMs * 2;
        this.lastWatchdogTick = now;

        // Send keepalive
        if (this.connected || this.hasEverConnected) {
            this._send(null, null, { type: 'keepAlive' });
        }

        if (!this.hasEverConnected) return;

        if (late) {
            // Our event loop stalled (GC, config-push storm): inbound packets
            // sat unread in the kernel buffer, so the silence window may be
            // our fault, not the peer's. Restart measurement instead of
            // counting a miss — otherwise a manager-side stall declares the
            // whole fleet dead at once.
            this.keepAliveTime = now;
            this.missedKeepalives = 0;
            return;
        }

        this.pruneEndpoints(now);

        if (now - this.keepAliveTime > this.connectionTimeout) {
            this.missedKeepalives++;
            if (this.missedKeepalives >= this.missedKeepaliveThreshold) {
                this.disconnect();
            }
        } else {
            this.missedKeepalives = 0;
        }
    }

    resetKeepalive(): void {
        this.keepAliveTime = Date.now();
        this.missedKeepalives = 0;
    }

    /** Mark this socket as having established a connection (enables disconnect detection). */
    markConnected(): void {
        this.hasEverConnected = true;
        this.keepAliveTime = Date.now();
    }

    // ---- Lifecycle -----------------------------------------------------------

    disconnect(): void {
        if (this._destroyed) return;
        this._destroyed = true;
        this.connected = false;

        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }

        // Clean up guaranteed-delivery timers + release retained fragments for this
        // socket. The transports are shared (owned by Server/Client) — don't destroy them.
        this.reliable.destroy();
        // A shared dedup table belongs to the Client and outlives this path.
        if (this.ownsDedup) this.dedup.clear();

        this.onDisconnectCb?.(this.socketID);
        this.emit('disconnected', this.socketID);

        if (!this.isClient) {
            this.removeAllListeners();
        }
    }

    destroy(): void {
        this.disconnect();
    }
}

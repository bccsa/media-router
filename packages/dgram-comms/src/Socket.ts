import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { encrypt } from './encryption.js';
import { FragmentTransport } from './FragmentTransport.js';
import { ReliableDelivery } from './ReliableDelivery.js';
import type { DgramMessage } from '@media-router/shared-types';

export interface SocketOptions {
    /** Remote port. */
    port: number;
    /** Remote address. */
    address: string;
    /** Shared fragment transport (owns the udp socket + fragment-level reliability). */
    transport: FragmentTransport;
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
}

/**
 * A single bidirectional connection.
 *
 * Handles the full pipeline:
 *   send: JSON → encrypt → fragment → UDP
 *   recv: UDP → reassemble → decrypt → JSON → emit(topic, message)
 *
 * Provides guaranteed delivery via ACK/retry with exponential backoff.
 * Sends keepalive heartbeats to detect connection loss.
 */
export class Socket extends EventEmitter {
    socketID: string;
    connected = false;
    readonly isClient: boolean;
    readonly clientID: string;

    private port: number;
    private address: string;
    private transport: FragmentTransport;
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

    /** Delivered seq → timestamp (ms). Dedups multi-path copies and retransmits; evicted by age. */
    private seenSeqs = new Map<number, number>();
    /** Age bound — must outlast the sender's ~13s fallback-resend window. */
    private readonly seqDedupTtlMs = 30000;
    /** Hard backstop; age eviction (seqDedupTtlMs) is the primary bound. */
    private readonly maxSeenSeqs = 65536;

    constructor(options: SocketOptions) {
        super();
        this.port = options.port;
        this.address = options.address;
        this.transport = options.transport;
        this.isClient = options.isClient ?? false;
        this.clientID = options.clientID ?? '';
        this.encryptionKey = options.encryptionKey;
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.onDisconnectCb = options.onDisconnect;
        this.reliable = new ReliableDelivery(
            this.transport,
            () => ({ port: this.port, address: this.address }),
            (info) => this.emit('ackTimeout', info),
            () => this.destroyed,
        );

        // Client sockets get their socketID assigned by the server
        this.socketID = this.isClient ? '' : crypto.randomUUID();

        this.startKeepalive();
    }

    /** Update remote address (NAT traversal). */
    updateRemote(port: number, address: string): void {
        this.port = port;
        this.address = address;
    }

    // ---- Send ---------------------------------------------------------------

    /**
     * Send a message to the remote side.
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

    private _send(
        topic: string | null,
        message: unknown,
        options: {
            type?: DgramMessage['type'];
            guaranteeDelivery?: boolean;
            ackID?: number;
            seq?: number;
        },
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
        const messageId = this.transport.send(buf, this.port, this.address, reliable);

        if (reliable && options.ackID !== undefined) {
            this.reliable.track(options.ackID, messageId, topic ?? undefined);
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
                // Dedup by sequence number. Multi-path copies and retransmits
                // share a seq; genuinely distinct messages always get distinct
                // seqs, so identical payloads are never wrongly dropped — the
                // old receive-time content hash did exactly that when latency
                // bunched packets into one 500ms window.
                if (msg.seq !== undefined) {
                    if (this.seenSeqs.has(msg.seq)) break;
                    this.markSeqSeen(msg.seq);
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
        }
    }

    private sendAck(ackID: number): void {
        this._send(null, null, { type: 'ack', ackID });
    }

    /**
     * Record a delivered sequence number. Evicts by age (older than
     * `seqDedupTtlMs`, which outlasts the retransmit window) so the table stays
     * bounded regardless of message rate — the count cap is only a backstop.
     * seq is monotonic per socket, so entries are inserted in time order and the
     * oldest is always at the front.
     */
    private markSeqSeen(seq: number): void {
        const now = Date.now();
        this.seenSeqs.set(seq, now);
        while (this.seenSeqs.size > 0) {
            const oldest = this.seenSeqs.keys().next().value as number;
            const ts = this.seenSeqs.get(oldest) ?? 0;
            if (this.seenSeqs.size <= this.maxSeenSeqs && now - ts <= this.seqDedupTtlMs) break;
            this.seenSeqs.delete(oldest);
        }
    }

    // ---- Keepalive -----------------------------------------------------------

    private startKeepalive(): void {
        if (this.keepAliveTimer) return;
        const interval = Math.max(this.connectionTimeout / 4, 500);
        this.keepAliveTimer = setInterval(() => {
            this.connectionWatchdog();
        }, interval);
    }

    private hasEverConnected = false;

    private connectionWatchdog(): void {
        if (this.destroyed) return;

        // Send keepalive
        if (this.connected || this.hasEverConnected) {
            this._send(null, null, { type: 'keepAlive' });
        }

        if (!this.hasEverConnected) return;

        if (Date.now() - this.keepAliveTime > this.connectionTimeout) {
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
        // socket. The transport itself is shared (owned by Server/Client) — don't destroy it.
        this.reliable.destroy();
        this.seenSeqs.clear();

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

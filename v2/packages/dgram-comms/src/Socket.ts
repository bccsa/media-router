import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { encrypt, decrypt } from './encryption.js';
import { fragment, Reassembler } from './fragmentation.js';
import type { DgramMessage } from '@media-router/shared-types';

let ackCounter = 0;

export interface SocketOptions {
    /** Remote port. */
    port: number;
    /** Remote address. */
    address: string;
    /** The underlying dgram socket to send on. */
    udpSocket: dgram.Socket;
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
    private udpSocket: dgram.Socket;
    private encryptionKey: string | undefined;
    private connectionTimeout: number;
    private missedKeepaliveThreshold: number;
    private onDisconnectCb: ((socketID: string) => void) | undefined;

    private reassembler: Reassembler;
    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private keepAliveTime = Date.now();
    private missedKeepalives = 0;
    private destroyed = false;

    /** Pending guaranteed-delivery messages awaiting ACK. */
    private waitingAck = new Map<number, ReturnType<typeof setTimeout>>();

    constructor(options: SocketOptions) {
        super();
        this.port = options.port;
        this.address = options.address;
        this.udpSocket = options.udpSocket;
        this.isClient = options.isClient ?? false;
        this.clientID = options.clientID ?? '';
        this.encryptionKey = options.encryptionKey;
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;
        this.onDisconnectCb = options.onDisconnect;
        this.reassembler = new Reassembler(this.connectionTimeout * 2);

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
        options: { type?: DgramMessage['type']; guaranteeDelivery?: boolean; ackID?: number } = {},
    ): void {
        if (this.destroyed) return;
        this._send(topic, message, options);
    }

    private async _send(
        topic: string | null,
        message: unknown,
        options: {
            type?: DgramMessage['type'];
            guaranteeDelivery?: boolean;
            ackID?: number;
            _retryCount?: number;
        },
    ): Promise<void> {
        // Assign ackID for guaranteed delivery
        if (!options.ackID && options.guaranteeDelivery) {
            ackCounter++;
            options.ackID = ackCounter;
        }

        const data: DgramMessage['data'] = {
            topic: topic ?? undefined,
            message,
            ackID: options.ackID,
            socketID: this.socketID,
        };

        // Encrypt if we have a key and this is a data/connect message
        const msgType = options.type ?? 'data';
        let envelope: DgramMessage;

        if (this.clientID && this.encryptionKey && (msgType === 'data' || msgType === 'connect')) {
            const encrypted = encrypt(JSON.stringify(data), this.encryptionKey);
            envelope = {
                type: msgType,
                clientID: this.clientID,
                iv: encrypted.iv,
                data: encrypted.data as unknown as DgramMessage['data'],
            };
        } else {
            envelope = {
                type: msgType,
                clientID: this.clientID,
                data,
            };
        }

        const buf = Buffer.from(JSON.stringify(envelope));
        const packets = fragment(buf);

        for (const packet of packets) {
            this.udpSocket.send(packet, this.port, this.address);
        }

        // Guaranteed delivery: schedule retry with exponential backoff
        if (options.guaranteeDelivery && options.ackID) {
            const retryCount = options._retryCount ?? 0;
            if (retryCount < 10) {
                // 200ms, 400ms, 800ms, 1600ms, then cap at 1600ms
                const delay = Math.min(200 * Math.pow(2, retryCount), 1600);
                const ackID = options.ackID;
                const timer = setTimeout(() => {
                    if (this.waitingAck.has(ackID) && !this.destroyed) {
                        this._send(topic, message, {
                            ...options,
                            _retryCount: retryCount + 1,
                        });
                    }
                }, delay);
                this.waitingAck.set(ackID, timer);
            } else {
                // Max retries — give up
                this.waitingAck.delete(options.ackID);
            }
        }
    }

    // ---- Receive -------------------------------------------------------------

    /**
     * Called by Server/Client when a reassembled, parsed message arrives for this socket.
     */
    handleMessage(msg: DgramMessage): void {
        this.resetKeepalive();

        switch (msg.type) {
            case 'keepAlive':
                break;

            case 'ack':
                if (msg.data?.ackID !== undefined) {
                    const timer = this.waitingAck.get(msg.data.ackID);
                    if (timer) {
                        clearTimeout(timer);
                        this.waitingAck.delete(msg.data.ackID);
                    }
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
                // Send ACK if requested
                if (msg.data?.ackID !== undefined) {
                    this.sendAck(msg.data.ackID);
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

        // Only send keepalive if we've connected at least once
        if (this.connected || this.hasEverConnected) {
            this._send(null, null, { type: 'keepAlive' });
        }

        // Only check timeout after we've connected at least once
        // (don't disconnect a client that's still trying to connect)
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

    // ---- Lifecycle -----------------------------------------------------------

    disconnect(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.connected = false;

        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }

        // Clean up pending ACKs
        for (const timer of this.waitingAck.values()) {
            clearTimeout(timer);
        }
        this.waitingAck.clear();

        this.reassembler.destroy();
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

import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import { decrypt } from './encryption.js';
import { Reassembler, parseFragmentHeader } from './fragmentation.js';
import { Socket } from './Socket.js';
import type { DgramMessage } from '@media-router/shared-types';

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
    private reassembler: Reassembler;

    /** Connected sockets by socketID. */
    private sockets = new Map<string, Socket>();
    /** Map clientID → socketID for targeted sends. */
    private clientToSocket = new Map<string, string>();

    constructor(options: ServerOptions = {}) {
        super();
        this.port = options.port ?? 3000;
        this.bindAddress = options.bindAddress ?? '0.0.0.0';
        this.encryptionKeys = { ...options.encryptionKeys };
        this.connectionTimeout = options.connectionTimeout ?? 5000;
        this.missedKeepaliveThreshold = options.missedKeepaliveThreshold ?? 3;

        this.udpSocket = dgram.createSocket('udp4');
        this.reassembler = new Reassembler(this.connectionTimeout * 2);

        this.udpSocket.on('error', (err) => {
            console.error(`[dgram-comms Server] error: ${err.message}`);
        });
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
        this.reassembler.destroy();
        return new Promise((resolve) => {
            this.udpSocket.close(() => resolve());
        });
    }

    /** Update encryption keys at runtime (e.g. when engines are added/removed). */
    refreshEncryptionKeys(keys: Record<string, string>): void {
        this.encryptionKeys = { ...keys };
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
        if (socketId) {
            const socket = this.sockets.get(socketId);
            socket?.send(topic, message, options);
        }
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
        // Reassemble fragments
        const complete = this.reassembler.addFragment(rawPacket);
        if (!complete) return;

        // Parse JSON
        let msg: DgramMessage;
        try {
            msg = JSON.parse(complete.toString());
        } catch {
            return;
        }

        // Decrypt data if encrypted
        const { type, clientID, iv } = msg;
        let data = msg.data;

        if (clientID && iv && typeof data === 'string') {
            const key = this.encryptionKeys[clientID];
            if (!key) {
                console.warn(`[dgram-comms Server] No key for client: ${clientID}`);
                return;
            }
            const decrypted = decrypt(data, iv, key);
            if (!decrypted) {
                console.warn(`[dgram-comms Server] Decryption failed for client: ${clientID}`);
                return;
            }
            try {
                data = JSON.parse(decrypted);
            } catch {
                return;
            }
        }

        // Route by message type
        switch (type) {
            case 'connect':
                console.log(`[dgram-comms Server] connect from ${clientID} (${rinfo.address}:${rinfo.port}), has key: ${!!this.encryptionKeys[clientID]}`);
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
        _data: DgramMessage['data'],
        rinfo: dgram.RemoteInfo,
    ): void {
        // Validate client has a registered encryption key
        if (!this.encryptionKeys[clientID]) return;

        // If client already connected, destroy old socket and create fresh one
        const existingSocketId = this.clientToSocket.get(clientID);
        if (existingSocketId) {
            const existing = this.sockets.get(existingSocketId);
            if (existing) {
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
            udpSocket: this.udpSocket,
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

        this.sockets.set(socket.socketID, socket);
        this.clientToSocket.set(clientID, socket.socketID);

        // Confirm connection
        socket.send('connected', socket.socketID, {
            type: 'connected',
            guaranteeDelivery: true,
        });

        socket.connected = true;
        this.emit('connection', socket, clientID);
    }

    private getSocketByDataSocketID(socketID: string | undefined): Socket | undefined {
        if (!socketID) return undefined;
        return this.sockets.get(socketID);
    }
}

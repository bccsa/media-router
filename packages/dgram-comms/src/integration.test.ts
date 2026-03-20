import { describe, it, expect, afterEach } from 'vitest';
import { Server } from './Server.js';
import { Client } from './Client.js';

describe('Server + Client integration', () => {
    let server: Server;
    let client: Client;

    afterEach(async () => {
        client?.destroy();
        await server?.stop();
    });

    it('client connects to server and exchanges encrypted messages', async () => {
        const password = 'test-secret';

        server = new Server({
            port: 0, // will bind to random port
            encryptionKeys: { 'engine-1': password },
        });

        // Bind to random port
        await new Promise<void>((resolve) => {
            server['udpSocket'].bind(0, '127.0.0.1', () => {
                // Manually set up message handler since we bypassed start()
                server['udpSocket'].on('message', (msg: Buffer, rinfo: any) => {
                    server['onPacket'](msg, rinfo);
                });
                resolve();
            });
        });

        const serverPort = server['udpSocket'].address().port;

        // Wait for server to accept connection
        const connectionPromise = new Promise<void>((resolve) => {
            server.on('connection', (_socket, clientId) => {
                expect(clientId).toBe('engine-1');
                resolve();
            });
        });

        client = new Client({
            clientId: 'engine-1',
            paths: [{ host: '127.0.0.1', port: serverPort }],
            encryptionKey: password,
            connectionTimeout: 2000,
        });

        // Wait for connection (with timeout)
        await Promise.race([
            connectionPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000)),
        ]);

        // Test message exchange: server → client
        const clientReceivedPromise = new Promise<{ topic: string; message: unknown }>((resolve) => {
            client.on('data', (topic: string, message: unknown) => {
                resolve({ topic, message });
            });
        });

        server.sendTo('engine-1', 'config', { modules: {} });

        const received = await Promise.race([
            clientReceivedPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Receive timeout')), 5000)),
        ]);

        expect(received.topic).toBe('config');
        expect(received.message).toEqual({ modules: {} });
    }, 10000);

    it('client sends message to server', async () => {
        const password = 'engine-pass';

        server = new Server({
            port: 0,
            encryptionKeys: { 'engine-2': password },
        });

        await new Promise<void>((resolve) => {
            server['udpSocket'].bind(0, '127.0.0.1', () => {
                server['udpSocket'].on('message', (msg: Buffer, rinfo: any) => {
                    server['onPacket'](msg, rinfo);
                });
                resolve();
            });
        });

        const serverPort = server['udpSocket'].address().port;

        // Wait for connection and capture the server-side socket
        const serverSocketPromise = new Promise<any>((resolve) => {
            server.on('connection', (socket) => {
                resolve(socket);
            });
        });

        client = new Client({
            clientId: 'engine-2',
            paths: [{ host: '127.0.0.1', port: serverPort }],
            encryptionKey: password,
            connectionTimeout: 2000,
        });

        const serverSocket = await Promise.race([
            serverSocketPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        // Wait for client to be fully connected
        if (!client.connected) {
            await new Promise<void>((resolve) => {
                client.on('connected', () => resolve());
            });
        }

        // Listen on server socket for client messages
        const serverReceivedPromise = new Promise<unknown>((resolve) => {
            serverSocket.on('state', (msg: unknown) => {
                resolve(msg);
            });
        });

        // Client sends to server
        client.send('state', { health: 'ok', running: true });

        const msg = await Promise.race([
            serverReceivedPromise,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);

        expect(msg).toEqual({ health: 'ok', running: true });
    }, 10000);
});

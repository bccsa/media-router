import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from './Server.js';
import { Client } from './Client.js';

describe('Server + Client integration', () => {
    let server: Server;
    let client: Client;

    afterEach(async () => {
        client?.destroy();
        client = undefined as unknown as Client;
        if (server) {
            await server.stop();
            server = undefined as unknown as Server;
        }
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
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout')), 5000),
            ),
        ]);

        // Test message exchange: server → client
        const clientReceivedPromise = new Promise<{ topic: string; message: unknown }>(
            (resolve) => {
                client.on('data', (topic: string, message: unknown) => {
                    resolve({ topic, message });
                });
            },
        );

        server.sendTo('engine-1', 'config', { modules: {} });

        const received = await Promise.race([
            clientReceivedPromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Receive timeout')), 5000),
            ),
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

    it('client recovers when a server restart kills its path socket', async () => {
        // Regression: a missed-keepalive death used to leave the path's
        // Socket permanently destroyed — every subsequent `send` dropped with
        // "socket destroyed, dropping message topic=..." even after a fresh
        // server came up on the same port. The path-level reconnect now
        // replaces the dead Socket so the client recovers on its own.
        const password = 'restart-secret';

        const startServer = async () =>
            new Promise<{ s: Server; port: number }>((resolve) => {
                const s = new Server({
                    port: 0,
                    encryptionKeys: { 'engine-r': password },
                });
                s['udpSocket'].bind(0, '127.0.0.1', () => {
                    s['udpSocket'].on('message', (msg: Buffer, rinfo: unknown) => {
                        s['onPacket'](msg, rinfo as Parameters<typeof s['onPacket']>[1]);
                    });
                    resolve({ s, port: s['udpSocket'].address().port });
                });
            });

        // Start server, connect client, then forcibly destroy the client-side
        // Socket to simulate the missed-keepalive watchdog firing.
        const first = await startServer();
        server = first.s;
        client = new Client({
            clientId: 'engine-r',
            paths: [{ host: '127.0.0.1', port: first.port }],
            encryptionKey: password,
            connectionTimeout: 2000,
        });
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('initial connect timeout')), 3000);
            client.on('connected', () => {
                clearTimeout(t);
                resolve();
            });
        });

        // Tear down the underlying Socket the way the watchdog does — this is
        // the state the bug fix is meant to recover from.
        const ps = (client as unknown as { pathStates: Array<{ socket: { disconnect(): void; destroyed: boolean } }> })
            .pathStates[0];
        ps.socket.disconnect();
        expect(ps.socket.destroyed).toBe(true);

        // Wait one reconnect tick (1s). connectPath should now notice the
        // dead Socket, replace it, and the new Socket should re-handshake
        // with the (still-running) server.
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('recovery timeout')), 5000);
            client.once('connected', () => {
                clearTimeout(t);
                resolve();
            });
        });

        // The replacement Socket should NOT be the dead one.
        const psAfter = (client as unknown as { pathStates: Array<{ socket: { destroyed: boolean } }> })
            .pathStates[0];
        expect(psAfter.socket.destroyed).toBe(false);
    }, 15000);

    it('destroyed Socket ignores in-flight `connected` packets', async () => {
        // Regression: Socket.handleMessage used to process incoming messages
        // even after `disconnect()`, so a delayed 'connected' reply (e.g.
        // arriving after the watchdog tore the socket down) would re-emit
        // 'connected' from a dead Socket. The higher level would then think
        // it was online while every send dropped with "socket destroyed".
        const { Socket: SocketCls } = await import('./Socket.js');
        const dgramMod = await import('dgram');
        const udp = dgramMod.createSocket('udp4');
        const s = new SocketCls({
            port: 1,
            address: '127.0.0.1',
            udpSocket: udp,
            isClient: true,
            clientID: 'test',
            encryptionKey: 'k',
            connectionTimeout: 500,
        });
        s.disconnect();

        const spy = vi.fn();
        s.on('connected', spy);
        s.handleMessage({
            type: 'connected',
            clientID: 'test',
            data: { socketID: 'x' },
        } as Parameters<typeof s.handleMessage>[0]);
        expect(spy).not.toHaveBeenCalled();
        expect(s.connected).toBe(false);
        udp.close();
    });
});

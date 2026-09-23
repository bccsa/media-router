import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from './Server.js';
import { Client } from './Client.js';
import type { FragmentTransport } from './FragmentTransport.js';

/**
 * Two manager listeners, one engine with a path to each. The session must be
 * ONE socket on the server, traffic must arrive exactly once in each
 * direction, and losing a whole path must neither drop the session nor lose
 * messages — the path re-joins the same session when it comes back.
 */
describe('multi-path: two listeners, two paths, one session', () => {
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

    const until = (what: string, ms: number, check: () => boolean) =>
        new Promise<void>((resolve, reject) => {
            const started = Date.now();
            const t = setInterval(() => {
                if (check()) {
                    clearInterval(t);
                    resolve();
                } else if (Date.now() - started > ms) {
                    clearInterval(t);
                    reject(new Error(`timeout waiting for ${what}`));
                }
            }, 25);
        });

    /** Make listener `i` deaf and mute — the path is "down" without ICMP noise. */
    const cutListener = (s: Server, i: number) => {
        const l = s['udpListeners'][i];
        const rx = vi.spyOn(l.transport, 'receive').mockReturnValue(null);
        const tx = vi.spyOn(l.transport, 'send').mockReturnValue(0);
        const rs = vi.spyOn(l.transport, 'resend').mockImplementation(() => {});
        return () => {
            rx.mockRestore();
            tx.mockRestore();
            rs.mockRestore();
        };
    };

    it('bonds both paths into one session, delivers once, survives a path cut, re-joins', async () => {
        const password = 'mp-secret';
        server = new Server({
            listeners: [
                { port: 0, bindAddress: '127.0.0.1' },
                { port: 0, bindAddress: '127.0.0.1' },
            ],
            encryptionKeys: { 'engine-mp': password },
            connectionTimeout: 1000,
            missedKeepaliveThreshold: 3,
        });
        await server.start();
        const ports = server['udpListeners'].map(
            (l: { udpSocket: { address(): { port: number } } }) => l.udpSocket.address().port,
        );
        expect(new Set(ports).size).toBe(2);

        const connections: string[] = [];
        const serverGot: unknown[] = [];
        server.on('connection', (socket, clientId: string) => {
            connections.push(clientId);
            socket.on('state', (m: unknown) => serverGot.push(m));
        });
        const serverPathDown = vi.fn();
        server.on('pathDown', serverPathDown);

        client = new Client({
            clientId: 'engine-mp',
            paths: [
                { host: '127.0.0.1', port: ports[0] },
                { host: '127.0.0.1', port: ports[1] },
            ],
            encryptionKey: password,
            connectionTimeout: 600,
            missedKeepaliveThreshold: 3,
        });
        const pathUps: number[] = [];
        const pathDowns: number[] = [];
        client.on('pathUp', (i: number) => pathUps.push(i));
        client.on('pathDown', (i: number) => pathDowns.push(i));
        const clientGot: unknown[] = [];
        client.on('data', (topic: string, m: unknown) => {
            if (topic === 'cfg') clientGot.push(m);
        });

        // Both paths up, ONE session with two endpoints, one connection event.
        await until('both paths up', 4000, () => client.connectedPaths.length === 2);
        await until('two endpoints', 2000, () => server.clientEndpoints('engine-mp').length === 2);
        expect(connections).toEqual(['engine-mp']);
        expect(server['sockets'].size).toBe(1);
        const socketId = server['clientToSocket'].get('engine-mp');

        // Server → client: fanned out on both paths, delivered exactly once.
        for (let i = 1; i <= 5; i++)
            server.sendTo('engine-mp', 'cfg', { i }, { guaranteeDelivery: i % 2 === 0 });
        await until('5 cfg', 2000, () => clientGot.length >= 5);
        await new Promise((r) => setTimeout(r, 300));
        expect(clientGot).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);

        // Client → server: sent on both paths, delivered exactly once.
        for (let i = 1; i <= 5; i++)
            client.send('state', { i }, { guaranteeDelivery: i % 2 === 1 });
        await until('5 state', 2000, () => serverGot.length >= 5);
        await new Promise((r) => setTimeout(r, 300));
        expect(serverGot).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }]);

        // Cut listener 0. The client's path 0 dies on its watchdog (~1.8-2.4 s);
        // the session stays up on path 1 and the server prunes the dead
        // endpoint after its own death window (3 s) — no disconnection.
        const disconnection = vi.fn();
        server.on('disconnection', disconnection);
        const clientDisconnected = vi.fn();
        client.on('disconnected', clientDisconnected);
        const restore = cutListener(server, 0);

        await until('client path 0 down', 6000, () => pathDowns.includes(0));
        expect(client.connected).toBe(true);
        await until(
            'server pruned endpoint',
            6000,
            () => server.clientEndpoints('engine-mp').length === 1,
        );
        expect(serverPathDown).toHaveBeenCalledWith('engine-mp', expect.any(String));
        expect(disconnection).not.toHaveBeenCalled();
        expect(clientDisconnected).not.toHaveBeenCalled();
        expect(server['clientToSocket'].get('engine-mp')).toBe(socketId);

        // Traffic still flows over the surviving path, still exactly once.
        clientGot.length = 0;
        serverGot.length = 0;
        server.sendTo('engine-mp', 'cfg', { after: 'cut' }, { guaranteeDelivery: true });
        client.send('state', { after: 'cut' }, { guaranteeDelivery: true });
        await until(
            'post-cut both ways',
            2000,
            () => clientGot.length >= 1 && serverGot.length >= 1,
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(clientGot).toEqual([{ after: 'cut' }]);
        expect(serverGot).toEqual([{ after: 'cut' }]);

        // Restore listener 0: path 0 re-handshakes with the same nonce and
        // JOINS the existing session — same socketID, no new connection event.
        restore();
        await until('path 0 back', 5000, () => client.connectedPaths.length === 2);
        await until(
            'two endpoints again',
            3000,
            () => server.clientEndpoints('engine-mp').length === 2,
        );
        expect(connections).toEqual(['engine-mp']);
        expect(server['clientToSocket'].get('engine-mp')).toBe(socketId);
        expect(pathUps.filter((i) => i === 0).length).toBe(2);
    }, 30000);
});

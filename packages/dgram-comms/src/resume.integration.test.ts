import { describe, it, expect, afterEach, vi } from 'vitest';
import { Server } from './Server.js';
import { Client } from './Client.js';

/**
 * A client that notices a dead link while the server does not comes back on
 * the session the server kept: the server re-acks it and sees no new
 * connection, so nothing a new session gets (the manager's hello and config
 * push) follows. The client says so with `resumed` (#857).
 */
describe('a session the server kept through the drop', () => {
    let server: Server;
    let client: Client;

    afterEach(async () => {
        vi.restoreAllMocks();
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

    async function start(serverTimeoutMs: number) {
        server = new Server({
            listeners: [{ port: 0, bindAddress: '127.0.0.1' }],
            encryptionKeys: { e1: 'pw' },
            connectionTimeout: serverTimeoutMs,
        });
        await server.start();
        const connections: string[] = [];
        const dropped: string[] = [];
        server.on('connection', (_s, id: string) => connections.push(id));
        server.on('disconnection', (id: string) => dropped.push(id));
        client = new Client({
            clientId: 'e1',
            paths: [
                { host: '127.0.0.1', port: server['udpListeners'][0].udpSocket.address().port },
            ],
            encryptionKey: 'pw',
            connectionTimeout: 500,
        });
        const connected: Array<{ resumed: boolean }> = [];
        let disconnects = 0;
        client.on('connected', (link: { resumed: boolean }) => connected.push(link));
        client.on('disconnected', () => disconnects++);
        await until('first connect', 3000, () => connected.length === 1);
        return { connections, dropped, connected, disconnects: () => disconnects };
    }

    /** Silence the server's sends, and its receives too when `both`. */
    const cut = (both: boolean) => {
        const transport = server['udpListeners'][0].transport;
        const spies = [
            vi.spyOn(transport, 'send').mockReturnValue(0),
            vi.spyOn(transport, 'resend').mockImplementation(() => {}),
            ...(both ? [vi.spyOn(transport, 'receive').mockReturnValue(null)] : []),
        ];
        return () => spies.forEach((s) => s.mockRestore());
    };

    it('reconnects with resumed: true, and the server sees no new connection', async () => {
        const r = await start(10_000);
        expect(r.connected).toEqual([{ resumed: false }]);
        const restore = cut(false);
        await until('client gives up the link', 6000, () => r.disconnects() === 1);
        restore();
        await until('reconnect', 4000, () => r.connected.length === 2);
        expect(r.connected[1]).toEqual({ resumed: true });
        expect(r.connections).toEqual(['e1']);
    }, 15_000);

    it('after the server dropped the session, the reconnect is a new one: resumed: false', async () => {
        const r = await start(1000);
        const restore = cut(true);
        await until(
            'server drops the session',
            8000,
            () => r.disconnects() === 1 && r.dropped.length === 1,
        );
        restore();
        await until('reconnect', 4000, () => r.connected.length === 2);
        expect(r.connected[1]).toEqual({ resumed: false });
        expect(r.connections).toEqual(['e1', 'e1']);
    }, 20_000);

    it('onAck runs once when the server acks; never for a message lost with the dead link', async () => {
        const r = await start(10_000);
        const delivered = vi.fn();
        client.send('t', { n: 1 }, { guaranteeDelivery: true, onAck: delivered });
        await until('ack', 3000, () => delivered.mock.calls.length > 0);
        const restore = cut(true);
        const lost = vi.fn();
        client.send('t', { n: 2 }, { guaranteeDelivery: true, onAck: lost });
        await until('client gives up the link', 6000, () => r.disconnects() === 1);
        restore();
        await until('reconnect', 4000, () => r.connected.length === 2);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(delivered).toHaveBeenCalledTimes(1);
        expect(lost).not.toHaveBeenCalled();
    }, 20_000);
});

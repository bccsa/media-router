import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { Client } from './Client.js';
import { DEFAULT_RECV_BUFFER_SIZE } from './constants.js';

// Wrap dgram.createSocket with a call-through spy so we can assert the recv
// buffer option is plumbed onto every path socket. Real sockets are still
// created (rmem_max clamping hides the enlarged size from getRecvBufferSize).
vi.mock('dgram', async (importOriginal) => {
    const actual = await importOriginal<typeof import('dgram')>();
    return { ...actual, createSocket: vi.fn(actual.createSocket) };
});

describe('Client', () => {
    let client: Client;

    afterEach(() => {
        client?.destroy();
    });

    it('creates each path socket with the default enlarged recv buffer', () => {
        vi.mocked(dgram.createSocket).mockClear();
        client = new Client({
            clientId: 'engine-1',
            paths: [{ host: '127.0.0.1', port: 3000 }],
            encryptionKey: 'secret',
        });
        expect(dgram.createSocket).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'udp4', recvBufferSize: DEFAULT_RECV_BUFFER_SIZE }),
        );
    });

    it('honours a custom recvBufferSize on every path', () => {
        vi.mocked(dgram.createSocket).mockClear();
        client = new Client({
            clientId: 'engine-1',
            paths: [
                { host: '127.0.0.1', port: 3000 },
                { host: '127.0.0.1', port: 3001 },
            ],
            encryptionKey: 'secret',
            recvBufferSize: 1_048_576,
        });
        const calls = vi
            .mocked(dgram.createSocket)
            .mock.calls.filter(
                ([opt]) =>
                    typeof opt === 'object' &&
                    (opt as dgram.SocketOptions).recvBufferSize === 1_048_576,
            );
        expect(calls.length).toBe(2);
    });

    it('connected says resumed only when every path was down and the server kept the session', () => {
        client = new Client({
            clientId: 'engine-1',
            paths: [
                { host: '127.0.0.1', port: 3000 },
                { host: '127.0.0.1', port: 3001 },
            ],
            encryptionKey: 'secret',
        });
        const links: Array<{ resumed: boolean }> = [];
        client.on('connected', (link) => links.push(link));
        const [a, b] = client['pathStates'];
        /** The server's handshake reply on a path, naming its session. */
        const handshake = (ps: typeof a, session: string) => {
            ps.socket.socketID = session;
            ps.socket.emit('connected');
        };
        handshake(a, 's1');
        handshake(b, 's1');
        // Path a re-handshakes while b carries the session: not a resume.
        a.connected = false;
        handshake(a, 's1');
        // Every path down, then back on the same session, then on a new one.
        a.connected = b.connected = false;
        handshake(a, 's1');
        a.connected = false;
        handshake(a, 's2');
        expect(links.map((l) => l.resumed)).toEqual([false, false, false, true, false]);
    });

    it('a guaranteed send on two paths calls onAck once, on the first ACK', () => {
        client = new Client({
            clientId: 'engine-1',
            paths: [
                { host: '127.0.0.1', port: 3000 },
                { host: '127.0.0.1', port: 3001 },
            ],
            encryptionKey: 'secret',
        });
        const acks: Array<() => void> = [];
        for (const ps of client['pathStates']) {
            ps.connected = true;
            vi.spyOn(ps.socket, 'send').mockImplementation((_t, _m, opts) => {
                if (opts?.onAck) acks.push(opts.onAck);
            });
        }
        const onAck = vi.fn();
        client.send('patch', { ops: [] }, { guaranteeDelivery: true, onAck });
        expect(acks).toHaveLength(2);
        acks[1]();
        acks[0]();
        expect(onAck).toHaveBeenCalledTimes(1);
    });

    it('destroy() is silent — emits neither disconnected nor pathDown', () => {
        // ManagerConnection rebuilds the Client inside createClient(); if
        // destroy() leaked a 'disconnected' event, the reconnect handler would
        // double-schedule and the backoff was bypassed entirely (the gate01
        // flat-5s reconnect hammer of 2026-07-18).
        client = new Client({
            clientId: 'engine-1',
            paths: [{ host: '127.0.0.1', port: 3000 }],
            encryptionKey: 'secret',
        });
        const disconnectedSpy = vi.fn();
        const pathDownSpy = vi.fn();
        client.on('disconnected', disconnectedSpy);
        client.on('pathDown', pathDownSpy);

        // Simulate an established path so teardown has state to tear down
        const ps = client['pathStates'][0];
        ps.connected = true;
        ps.alive = true;
        ps.socket.connected = true;
        ps.socket.markConnected();

        client.destroy();

        expect(disconnectedSpy).not.toHaveBeenCalled();
        expect(pathDownSpy).not.toHaveBeenCalled();
    });
});

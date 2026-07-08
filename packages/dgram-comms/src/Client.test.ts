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
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PacedUnixStreamTsSink } from './PacedUnixStreamTsSink.js';
import { TS_PACKET_BYTES } from './PacedTsSink.js';

/** One sink datagram (the stream chunk size = 128 TS packets). */
const CHUNK = 128 * TS_PACKET_BYTES;

/**
 * Real unix-socket round-trips (no fake timers — `mediaSeconds: 0` keeps every
 * datagram inside the prefill window, so pacing never delays the test).
 */
describe('PacedUnixStreamTsSink', () => {
    let dir: string;
    let server: Server | null = null;
    let serverSocks: Socket[] = [];
    let sink: PacedUnixStreamTsSink | null = null;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mr-sink-test-'));
    });

    /** net.Server.close waits for open connections — destroy them first. */
    async function closeServer(): Promise<void> {
        serverSocks.splice(0).forEach((s) => s.destroy());
        await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
        server = null;
    }

    afterEach(async () => {
        await sink?.end().catch(() => {});
        sink = null;
        await closeServer();
        rmSync(dir, { recursive: true, force: true });
    });

    function listen(path: string, onData: (buf: Buffer) => void): Promise<void> {
        return new Promise((resolve) => {
            server = createServer((sock) => {
                serverSocks.push(sock);
                sock.on('data', onData);
                sock.on('error', () => {});
            });
            server.listen(path, resolve);
        });
    }

    it('connects and delivers the byte stream intact', async () => {
        const path = join(dir, 'ingest.sock');
        const received: Buffer[] = [];
        await listen(path, (buf) => received.push(buf));

        sink = new PacedUnixStreamTsSink(path);
        const payload = Buffer.alloc(CHUNK, 0x47);
        await sink.write(payload, 0);

        await vi.waitFor(() => {
            expect(Buffer.concat(received).length).toBe(CHUNK);
        });
        expect(Buffer.concat(received).equals(payload)).toBe(true);
        expect(sink.bytesSent).toBe(CHUNK);
    });

    it('write blocks until the server accepts, then flushes (sidecar starting late)', async () => {
        const path = join(dir, 'late.sock');
        const received: Buffer[] = [];

        sink = new PacedUnixStreamTsSink(path);
        const pending = sink.write(Buffer.alloc(CHUNK, 1), 0);
        // Give the connect-retry loop a failed attempt before the server is up.
        await new Promise((r) => setTimeout(r, 100));
        await listen(path, (buf) => received.push(buf));

        await pending;
        await vi.waitFor(() => {
            expect(Buffer.concat(received).length).toBe(CHUNK);
        });
    });

    it('sheds while disconnected and resumes after the server returns (sidecar restart)', async () => {
        const path = join(dir, 'restart.sock');
        const received: Buffer[] = [];
        await listen(path, (buf) => received.push(buf));

        sink = new PacedUnixStreamTsSink(path);
        await sink.write(Buffer.alloc(CHUNK, 1), 0);
        await vi.waitFor(() => expect(Buffer.concat(received).length).toBe(CHUNK));

        // "Sidecar dies": close the listener and its accepted sockets.
        await closeServer();
        received.length = 0;
        // Give the sink's 'close' handler a beat to drop the dead socket.
        await vi.waitFor(() => {
            expect((sink as unknown as { socket: unknown }).socket).toBeNull();
        });

        // Writes during the outage are shed (background reconnect keeps retrying).
        await sink.write(Buffer.alloc(CHUNK, 2), 0);
        await new Promise((r) => setTimeout(r, 50));
        expect(received.length).toBe(0);

        // "Sidecar respawns": data flows again on the next write. A dead
        // server leaves its socket file behind — unlink before re-binding
        // (the real sidecar's unlink_stale does the same).
        rmSync(path, { force: true });
        await listen(path, (buf) => received.push(buf));
        await vi.waitFor(async () => {
            await sink!.write(Buffer.alloc(CHUNK, 3), 0);
            expect(Buffer.concat(received).length).toBeGreaterThan(0);
        });
    });
});

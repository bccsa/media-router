import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { unixFdSrcSocketPaths, probeUnixSocket, waitForBusSockets } from './busSocketGate.js';

const paths: string[] = [];
const servers: Server[] = [];

function scratchPath(): string {
    const p = `${tmpdir()}/gate-test-${process.pid}-${paths.length}.sock`;
    paths.push(p);
    return p;
}

function listen(path: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        const srv = createServer(() => {});
        servers.push(srv);
        srv.once('error', reject);
        srv.listen(path, () => resolve(srv));
    });
}

afterEach(async () => {
    for (const srv of servers.splice(0)) await new Promise((r) => srv.close(r));
    for (const p of paths.splice(0)) {
        try {
            unlinkSync(p);
        } catch {
            /* already gone */
        }
    }
});

describe('unixFdSrcSocketPaths', () => {
    it('extracts every unixfdsrc socket path', () => {
        const pipeline =
            'unixfdsrc name=a socket-path=/tmp/mr-bus-40000.sock ! tsdemux ! ' +
            'unixfdsrc socket-path=/tmp/mr-bus-40001.sock ! fakesink';
        expect(unixFdSrcSocketPaths(pipeline)).toEqual([
            '/tmp/mr-bus-40000.sock',
            '/tmp/mr-bus-40001.sock',
        ]);
    });
    it('does not match unixfdsink (producer side)', () => {
        expect(
            unixFdSrcSocketPaths('mpegtsmux ! unixfdsink socket-path=/tmp/mr-bus-1.sock'),
        ).toEqual([]);
    });
    it('returns empty for udp pipelines', () => {
        expect(unixFdSrcSocketPaths('udpsrc port=40000 ! tsparse ! fakesink')).toEqual([]);
    });
});

describe('probeUnixSocket', () => {
    it('resolves true for a listening socket', async () => {
        const p = scratchPath();
        await listen(p);
        expect(await probeUnixSocket(p)).toBe(true);
    });
    it('resolves false when nothing listens (no socket file)', async () => {
        expect(await probeUnixSocket(scratchPath())).toBe(false);
    });
    it('resolves false for a stale non-socket file (crashed-producer leftover)', async () => {
        const p = scratchPath();
        writeFileSync(p, '');
        expect(await probeUnixSocket(p)).toBe(false);
    });
});

describe('waitForBusSockets', () => {
    it('waits until a late producer binds, reporting the pending path once', async () => {
        const p = scratchPath();
        const pending: string[][] = [];
        setTimeout(() => void listen(p), 200);
        const ok = await waitForBusSockets([p], {
            deadlineMs: 3000,
            intervalMs: 50,
            onWait: (x) => pending.push(x),
        });
        expect(ok).toBe(true);
        expect(pending).toEqual([[p]]);
    });
    it('gives up at the deadline when the producer never appears', async () => {
        const ok = await waitForBusSockets([scratchPath()], { deadlineMs: 400, intervalMs: 50 });
        expect(ok).toBe(false);
    });
    it('resolves immediately (no onWait) when all sockets are already up', async () => {
        const p = scratchPath();
        await listen(p);
        let waited = false;
        const ok = await waitForBusSockets([p], {
            deadlineMs: 500,
            onWait: () => {
                waited = true;
            },
        });
        expect(ok).toBe(true);
        expect(waited).toBe(false);
    });
});

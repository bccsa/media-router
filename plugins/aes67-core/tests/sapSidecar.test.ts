import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * The SAP sidecar end to end: one process announcing, another discovering, over
 * real sockets.
 *
 * It runs on 127.0.0.1 rather than the real SAP group because `lo` carries no
 * MULTICAST flag, so a join would fail on every dev box and CI runner — and a
 * suite that silently skips is what this is meant to replace. The sidecar
 * treats a unicast `--group` as a plain destination (its multicast socket
 * options are skipped), so everything ABOVE the socket — announcement timing,
 * SDP, the hash, the snapshot protocol, the deletion on shutdown — is the same
 * code the multicast path runs.
 */

const SIDECAR = join(__dirname, '../py/mr-sap.py');
const havePython = spawnSync('python3', ['--version']).status === 0;

/** Ephemeral-ish port per test so parallel runs don't collide. */
let nextPort = 19875;
const takePort = (): number => nextPort++;

const children: ChildProcess[] = [];

function start(args: string[], onLine: (msg: Record<string, unknown>) => void): ChildProcess {
    const child = spawn('python3', [SIDECAR, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
                onLine(JSON.parse(line) as Record<string, unknown>);
            } catch {
                /* not JSON — sidecar debug output */
            }
        }
    });
    return child;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 8000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = predicate();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for sidecar event');
        await new Promise((r) => setTimeout(r, 50));
    }
}

/** `--flag value` pairs from a record — one readable line per option. */
function flags(pairs: Record<string, string | number>): string[] {
    return Object.entries(pairs).flatMap(([k, v]) => [`--${k}`, String(v)]);
}

const listenerArgs = (port: number, extra: Record<string, string | number> = {}): string[] => [
    '--listen',
    ...flags({ group: '127.0.0.1', port, ...extra }),
];

const announcerArgs = (port: number, extra: Record<string, string | number> = {}): string[] => [
    '--announce',
    ...flags({ group: '127.0.0.1', port, 'source-ip': '127.0.0.1', ...extra }),
];

interface Stream {
    name: string;
    address: string;
    port: number;
    encoding: string;
    channels: number;
    payloadType: number;
    ptimeMs: number;
    refclk: string | null;
}

afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
});

describe.skipIf(!havePython)('mr-sap.py announce ↔ discover', () => {
    it('an announced session reaches a listener with its stream parameters', async () => {
        const port = takePort();
        const snapshots: Stream[][] = [];
        start(listenerArgs(port, { timeout: 5 }), (msg) => {
            if (msg.event === 'streams') snapshots.push(msg.streams as Stream[]);
        });
        await waitFor(() => (snapshots.length ? true : undefined));
        expect(snapshots[0]).toEqual([]); // listener publishes an empty snapshot up front

        start(
            announcerArgs(port, {
                'session-name': 'Studio A',
                'stream-address': '239.69.0.1',
                'stream-port': 5004,
                encoding: 'L24',
                channels: 2,
                ptime: 1,
                'payload-type': 98,
                interval: 1,
            }),
            () => {},
        );

        const stream = await waitFor(() => snapshots[snapshots.length - 1]?.[0]);
        expect(stream.name).toBe('Studio A');
        expect(stream.address).toBe('239.69.0.1');
        expect(stream.port).toBe(5004);
        expect(stream.encoding).toBe('L24');
        expect(stream.channels).toBe(2);
        expect(stream.payloadType).toBe(98);
        expect(stream.ptimeMs).toBe(1);
        // No grandmaster passed ⇒ no RFC 7273 claim on the wire.
        expect(stream.refclk).toBeNull();
    }, 30_000);

    it('announces the RFC 7273 clock only when a grandmaster is given', async () => {
        const port = takePort();
        const snapshots: Stream[][] = [];
        start(listenerArgs(port), (msg) => {
            if (msg.event === 'streams') snapshots.push(msg.streams as Stream[]);
        });
        await waitFor(() => (snapshots.length ? true : undefined));
        start(
            announcerArgs(port, {
                'session-name': 'Locked',
                'stream-address': '239.69.0.2',
                'stream-port': 5004,
                'ptp-gmid': '00-1D-C1-FF-FE-50-30-EE',
                'ptp-domain': 0,
                interval: 1,
            }),
            () => {},
        );
        const stream = await waitFor(() => snapshots[snapshots.length - 1]?.[0]);
        expect(stream.refclk).toBe('ptp=IEEE1588-2008:00-1D-C1-FF-FE-50-30-EE:0');
    }, 30_000);

    it('re-announcements do not duplicate the session', async () => {
        const port = takePort();
        const snapshots: Stream[][] = [];
        start(listenerArgs(port), (msg) => {
            if (msg.event === 'streams') snapshots.push(msg.streams as Stream[]);
        });
        await waitFor(() => (snapshots.length ? true : undefined));
        start(
            announcerArgs(port, {
                'stream-address': '239.69.0.3',
                'stream-port': 5004,
                interval: 0.2,
            }),
            () => {},
        );
        await waitFor(() => snapshots[snapshots.length - 1]?.[0]);
        await new Promise((r) => setTimeout(r, 1500)); // several announcements
        expect(snapshots[snapshots.length - 1]).toHaveLength(1);
        // Snapshots are emitted on CHANGE only, so a steady sender is quiet.
        expect(snapshots.length).toBeLessThanOrEqual(3);
    }, 30_000);

    it('a stopped sender deletes its session immediately, not after a timeout', async () => {
        // The deletion packet is what keeps a stopped stream out of every other
        // device's picker for the next five minutes.
        const port = takePort();
        const snapshots: Stream[][] = [];
        start(listenerArgs(port), (msg) => {
            if (msg.event === 'streams') snapshots.push(msg.streams as Stream[]);
        });
        await waitFor(() => (snapshots.length ? true : undefined));
        const announcer = start(
            announcerArgs(port, {
                'stream-address': '239.69.0.4',
                'stream-port': 5004,
                interval: 30,
            }),
            () => {},
        );
        await waitFor(() => snapshots[snapshots.length - 1]?.[0]);
        announcer.kill('SIGTERM');
        const gone = await waitFor(() =>
            snapshots[snapshots.length - 1]?.length === 0 ? true : undefined,
        );
        expect(gone).toBe(true);
    }, 30_000);

    it('reports its own SDP on ready, so a misconfigured announcement is visible', async () => {
        const port = takePort();
        let sdp = '';
        start(
            announcerArgs(port, {
                'session-name': 'Ready Check',
                'stream-address': '239.69.0.5',
                'stream-port': 5004,
                ttl: 8,
            }),
            (msg) => {
                if (msg.event === 'ready') sdp = String(msg.sdp ?? '');
            },
        );
        await waitFor(() => (sdp ? true : undefined));
        expect(sdp).toContain('s=Ready Check');
        expect(sdp).toContain('c=IN IP4 239.69.0.5/8');
        expect(sdp).toContain('a=rtpmap:96 L24/48000/2');
        expect(sdp).toContain('a=ptime:1');
    }, 30_000);
});

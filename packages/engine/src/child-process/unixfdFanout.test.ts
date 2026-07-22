import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIDECAR = join(__dirname, 'unixfd-fanout.py');
const CLIENT = join(__dirname, 'unixfd-fanout.test-client.py');
const CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';
/** Must match the sidecar's BUFFER_BYTES (128 TS packets). */
const BUFFER_BYTES = 128 * 188;

const havePython = spawnSync('python3', ['--version']).status === 0;

/** Synthetic TS: 0x47 sync + 187×0xAA per packet, so all-0x47 data can't
 *  fake the client's stride alignment check. */
function tsPackets(count: number): Buffer {
    const buf = Buffer.alloc(count * 188, 0xaa);
    for (let i = 0; i < count; i++) buf[i * 188] = 0x47;
    return buf;
}

/** Collect JSON lines from a child's stdout into an inspectable array. */
function jsonLines(proc: ChildProcess): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
            try {
                out.push(JSON.parse(line));
            } catch {
                /* non-JSON noise */
            }
        }
    });
    return out;
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = probe();
        if (v !== undefined) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

/**
 * Full GstUnixFd protocol round-trips against the real sidecar, with a python
 * stand-in for unixfdsrc on the consumer end (receiving SCM_RIGHTS fds needs
 * python on both sides — Node can't).
 */
describe.skipIf(!havePython)('unixfd-fanout.py protocol', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    interface Rig {
        sidecar: ChildProcess;
        sidecarEvents: Array<Record<string, unknown>>;
        client: ChildProcess;
        clientEvents: Array<Record<string, unknown>>;
        /** Registered at spawn — awaiting `client.once('exit')` later races a
         *  fast-exiting client (event already fired → await hangs forever). */
        clientExit: Promise<number | null>;
        ingest: string;
        edge: string;
    }

    /** Sidecar up + edge attached + client (expecting `buffers`) connected. */
    async function rig(buffers: number): Promise<Rig> {
        const dir = mkdtempSync(join(tmpdir(), 'mr-fanout-test-'));
        cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
        const ingest = join(dir, 'ingest.sock');
        const edge = join(dir, 'edge.sock');

        const sidecar = spawn('python3', [SIDECAR, '--ingest', ingest, '--caps', CAPS], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        cleanups.push(() => sidecar.kill('SIGKILL'));
        sidecar.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
        const sidecarEvents = jsonLines(sidecar);
        await waitFor(() => sidecarEvents.find((e) => e.event === 'ready'), 'sidecar ready');

        // Engine-side attach (the UnixFdFanoutController's wire format).
        sidecar.stdin!.write(
            JSON.stringify({ cmd: 'bus_attach', tee: 'busout_41000', socket: edge }) + '\n',
        );
        await waitFor(
            () => sidecarEvents.find((e) => e.event === 'attached' && e.socket === edge),
            'edge attached',
        );

        // Consumer connects BEFORE data flows (no replay on the bus).
        const client = spawn('python3', [CLIENT, edge, '--buffers', String(buffers)], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        cleanups.push(() => client.kill('SIGKILL'));
        client.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
        const clientEvents = jsonLines(client);
        const clientExit = new Promise<number | null>((res) => client.once('exit', res));
        await waitFor(
            () => clientEvents.find((e) => e.event === 'client-connected'),
            'client connected',
        );
        return { sidecar, sidecarEvents, client, clientEvents, clientExit, ingest, edge };
    }

    function producer(ingest: string): Promise<Socket> {
        const sock = connect(ingest);
        return new Promise((resolve, reject) => {
            sock.once('connect', () => resolve(sock));
            sock.once('error', reject);
        });
    }

    it('serves CAPS-first, then a spec-shaped NEW_BUFFER with the ingested bytes on a memfd', async () => {
        const r = await rig(1);

        const p = await producer(r.ingest);
        cleanups.push(() => p.destroy());
        p.write(tsPackets(128)); // exactly one sidecar buffer

        const verdict = await waitFor(
            () => r.clientEvents.find((e) => e.result || e.error),
            'client verdict',
        );
        expect(verdict.error).toBeUndefined();
        expect(verdict.result).toMatchObject({
            ptsValid: true, // absolute CLOCK_MONOTONIC ns
            noneFields: true, // dts/duration/offset/offset_end = CLOCK_TIME_NONE
            flags: 0,
            memType: 0, // MEMORY_TYPE_DEFAULT
            nMemory: 1,
            nMeta: 0,
            memSize: BUFFER_BYTES,
            memOffset: 0,
            tsAligned: true,
        });
        expect(r.clientEvents.find((e) => e.caps)?.caps).toBe(CAPS);

        // RELEASE_BUFFER was drained — the sidecar is still alive and serving.
        const exit = await r.clientExit;
        expect(exit).toBe(0);
        expect(r.sidecar.exitCode).toBeNull();

        // Clean detach unlinks the edge socket.
        r.sidecar.stdin!.write(JSON.stringify({ cmd: 'bus_detach', socket: r.edge }) + '\n');
        await waitFor(
            () => r.sidecarEvents.find((e) => e.event === 'detached' && e.socket === r.edge),
            'edge detached',
        );
    }, 15000);

    it('stays TS-aligned across a producer respawn that died mid-packet', async () => {
        const r = await rig(2);

        // Producer incarnation 1: one whole buffer + a truncated packet, then
        // dies (hls child killed mid-write). The stale sub-packet tail must be
        // DISCARDED — splicing it before the next incarnation's aligned bytes
        // would desync every buffer boundary from then on.
        const p1 = await producer(r.ingest);
        p1.write(Buffer.concat([tsPackets(128), tsPackets(1).subarray(0, 100)]));
        await waitFor(
            () => r.clientEvents.find((e) => (e.result as { n?: number })?.n === 0),
            'first buffer',
        );
        p1.destroy();
        await new Promise((res) => setTimeout(res, 100)); // let close_ingest run

        // Producer incarnation 2: clean aligned stream.
        const p2 = await producer(r.ingest);
        cleanups.push(() => p2.destroy());
        p2.write(tsPackets(128));

        const second = await waitFor(
            () =>
                r.clientEvents
                    .map((e) => e.result as { n?: number; tsAligned?: boolean } | undefined)
                    .find((res) => res?.n === 1),
            'second buffer',
        );
        expect(second).toMatchObject({ memSize: BUFFER_BYTES, tsAligned: true });

        const exit = await r.clientExit;
        expect(exit).toBe(0);
    }, 15000);
});

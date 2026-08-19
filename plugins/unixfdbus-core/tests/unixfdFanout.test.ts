import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PTS_WRAP,
    STEP,
    ladderFixture,
    rungs,
    toNs,
} from '../../mpegts-core/tests/tsFixtures';

const SIDECAR = join(__dirname, '../py/unixfd-fanout.py');
/** Native drop-in (built by `make native` on Linux / build-native-dev.sh). */
const NATIVE_SIDECAR = join(__dirname, '../native/mr-bus-fanout/mr-bus-fanout');
const CLIENT = join(__dirname, '../py/unixfd-fanout.test-client.py');
const CAPS = 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188';
/** Must match the sidecar's BUFFER_BYTES (128 TS packets). */
const BUFFER_BYTES = 128 * 188;

const havePython = spawnSync('python3', ['--version']).status === 0;
// The protocol needs Linux on the sidecar side (memfd_create); the python
// leg is skipped off-Linux for the same reason the native one is.
const isLinux = process.platform === 'linux';
const haveNative = isLinux && existsSync(NATIVE_SIDECAR);

/** Synthetic TS: 0x47 sync + 187×0xAA per packet, so all-0x47 data can't
 *  fake the client's stride alignment check. */
function tsPackets(count: number): Buffer {
    const buf = Buffer.alloc(count * 188, 0xaa);
    for (let i = 0; i < count; i++) buf[i * 188] = 0x47;
    return buf;
}

/**
 * One buffer's worth of packets per rung, led by a PES packet and padded with
 * PES-less fillers: the sidecar chunks ingest at BUFFER_BYTES, so rung k is
 * broadcast buffer k and its stamp must map `pes[k]`.
 */
const ladder128 = (ladder: bigint[]) =>
    ladderFixture(ladder, { packetsPerRung: BUFFER_BYTES / 188 });

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

type SpawnSidecar = (ingest: string, extraArgs: string[]) => ChildProcess;

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
async function rig(
    cleanups: Array<() => void>,
    spawnSidecar: SpawnSidecar,
    buffers: number,
    extraArgs: string[] = [],
): Promise<Rig> {
    const dir = mkdtempSync(join(tmpdir(), 'mr-fanout-test-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ingest = join(dir, 'ingest.sock');
    const edge = join(dir, 'edge.sock');

    const sidecar = spawnSidecar(ingest, extraArgs);
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

interface Stamped {
    /** Wire pts — absolute CLOCK_MONOTONIC ns (u64, hence bigint). */
    pts: bigint;
    /** The buffer's first PES PTS (90 kHz), read back from the payload. */
    firstPes: bigint;
}

/**
 * Run `ladder` through a sidecar and collect one wire timestamp per broadcast
 * buffer. The fixture is packet-exact (one rung per BUFFER_BYTES chunk), so
 * buffer k must describe rung k — asserted here rather than assumed.
 */
async function stampLadder(
    cleanups: Array<() => void>,
    spawnSidecar: SpawnSidecar,
    ladder: bigint[],
    extraArgs: string[],
): Promise<Stamped[]> {
    const r = await rig(cleanups, spawnSidecar, ladder.length, extraArgs);
    const p = await producer(r.ingest);
    cleanups.push(() => p.destroy());
    p.write(ladder128(ladder));
    await waitFor(
        () => (r.clientEvents.filter((e) => e.result).length === ladder.length ? true : undefined),
        `${ladder.length} stamped buffers`,
        15000,
    );
    const bad = r.clientEvents.find((e) => e.error);
    expect(bad?.error).toBeUndefined();
    return r.clientEvents
        .map((e) => e.result as { pts: string; firstPes: number } | undefined)
        .filter((v): v is { pts: string; firstPes: number } => v !== undefined)
        .map((v) => ({ pts: BigInt(v.pts), firstPes: BigInt(v.firstPes) }));
}

/**
 * Full GstUnixFd protocol round-trips against a real sidecar, with a python
 * stand-in for unixfdsrc on the consumer end (receiving SCM_RIGHTS fds needs
 * python — Node can't). Parameterized over both server implementations: the
 * python reference (unixfd-fanout.py) and the native drop-in (mr-bus-fanout)
 * — identical CLI, verbs, and events, so the suite body is shared verbatim.
 */
function conformanceSuite(spawnSidecar: SpawnSidecar) {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    it('serves CAPS-first, then a spec-shaped NEW_BUFFER with the ingested bytes on a memfd', async () => {
        const r = await rig(cleanups, spawnSidecar, 1);

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
        const r = await rig(cleanups, spawnSidecar, 2);

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

    // --- time-sync contract (ADR-0005 decision 2) --------------------------
    // R8: the contract is opt-in, and with the flag off nothing may change —
    // the wire pts stays send time, i.e. "now" on the shared CLOCK_MONOTONIC.
    it('stamps send-time pts with the contract OFF', async () => {
        const before = process.hrtime.bigint(); // node's hrtime IS CLOCK_MONOTONIC
        const stamps = await stampLadder(cleanups, spawnSidecar, rungs(6, 8_100_000n), []);
        const after = process.hrtime.bigint();
        expect(stamps).toHaveLength(6);
        expect(stamps.every((s) => s.pts > before && s.pts < after)).toBe(true);
        // Send time tracks the wall, not the ladder: a fixture written in one
        // go arrives far faster than its 40 ms/rung media rate.
        expect(stamps[5].pts - stamps[0].pts).toBeLessThan(toNs(5n * STEP));
    }, 20000);

    // R6: with the contract on, the wire carries mapped MEDIA time — so every
    // inter-buffer delta is the PES delta exactly, whatever the arrival timing.
    it('stamps mapped media time with --stamp-timeline: deltas ARE the PES deltas', async () => {
        const ladder = rungs(12, 8_100_000n);
        const stamps = await stampLadder(cleanups, spawnSidecar, ladder, ['--stamp-timeline']);
        expect(stamps.map((s) => s.firstPes)).toEqual(ladder); // buffer k = rung k
        for (let i = 1; i < stamps.length; i++) {
            expect(stamps[i].pts - stamps[i - 1].pts).toBe(
                toNs(stamps[i].firstPes - stamps[i - 1].firstPes),
            );
        }
        // The anchor is the only clock-derived quantity, and it is latched on
        // the first PES — so the whole ladder hangs off buffer 0.
        const anchor = stamps[0].pts;
        expect(stamps.map((s) => s.pts)).toEqual(
            ladder.map((pes) => anchor + toNs(pes - ladder[0])),
        );
    }, 20000);

    // R7: a shed run (the leaky queue dropping buffers under a stalled
    // consumer) changes the SPACING, never the mapping — a PES-derived stamp
    // is drop-immune, where an arrival-derived one silently compresses.
    it('maps a gap in the ladder to its own PES delta, not one step', async () => {
        const ladder = [0n, 1n, 2n, 8n, 9n, 10n].map((k) => 8_100_000n + k * STEP);
        const stamps = await stampLadder(cleanups, spawnSidecar, ladder, ['--stamp-timeline']);
        expect(stamps[3].pts - stamps[2].pts).toBe(toNs(6n * STEP));
        expect(stamps[4].pts - stamps[3].pts).toBe(toNs(STEP));
    }, 20000);

    // The 2026-08-13 field failure, on the wire. A looping VOD rewinds its PES
    // timeline to ~0 every pass; a SINGLE-PID stream (which is exactly what
    // every mr-tssplit output is) then gives the watch only ONE anomaly, so
    // the cross-PID confirmation the case above relies on can never be
    // satisfied. Before the same-PID path existed no re-anchor was emitted at
    // all and the monotone floor pinned every later stamp to the last pre-loop
    // value for the rest of the loop — 11.6 minutes of it, measured on .202.
    it('re-anchors a SINGLE-PID stream when its source loops back to zero', async () => {
        const PRE = 6;
        const ladder = [...rungs(PRE, 8_100_000n), ...rungs(10, 4500n)];
        const r = await rig(cleanups, spawnSidecar, ladder.length, ['--stamp-timeline']);
        const p = await producer(r.ingest);
        cleanups.push(() => p.destroy());
        p.write(ladder128(ladder));
        await waitFor(
            () =>
                r.clientEvents.filter((e) => e.result).length === ladder.length
                    ? true
                    : undefined,
            `${ladder.length} stamped buffers`,
            15000,
        );
        const reanchor = await waitFor(
            () => r.sidecarEvents.find((e) => e.event === 'timeline_reanchor'),
            'a re-anchor event',
            15000,
        );
        expect(reanchor).toMatchObject({ pid: 0x100, count: 1 });
        const pts = r.clientEvents
            .map((e) => e.result as { pts: string } | undefined)
            .filter((v): v is { pts: string } => v !== undefined)
            .map((v) => BigInt(v.pts));
        // The timeline is LIVE again on the far side of the loop. A surviving
        // floor would flatten every one of these steps to zero instead.
        for (let i = PRE + 2; i < pts.length; i++) {
            expect(pts[i] - pts[i - 1]).toBe(toNs(STEP));
        }
    }, 20000);

    // The 33-bit 90 kHz counter wraps every ~26.5 h. `unwrap_near` has to
    // absorb it: a wrap is the same 40 ms step as any other rung, never a
    // 26.5 h jump and never a re-anchor (the 2026-07-23 wrap drill).
    it('carries a legal 2^33 PTS wrap as one continuous timeline', async () => {
        const ladder = rungs(8, PTS_WRAP - 3n * STEP);
        const stamps = await stampLadder(cleanups, spawnSidecar, ladder, ['--stamp-timeline']);
        for (let i = 1; i < stamps.length; i++) {
            expect(stamps[i].pts - stamps[i - 1].pts).toBe(toNs(STEP));
        }
    }, 20000);
}

const pythonSidecar: SpawnSidecar = (ingest, extra) =>
    spawn('python3', [SIDECAR, '--ingest', ingest, '--caps', CAPS, ...extra], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

const nativeSidecar: SpawnSidecar = (ingest, extra) =>
    spawn(NATIVE_SIDECAR, ['--ingest', ingest, '--caps', CAPS, ...extra], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

describe.skipIf(!havePython || !isLinux)('unixfd-fanout.py protocol', () => {
    conformanceSuite(pythonSidecar);
});

describe.skipIf(!havePython || !haveNative)('mr-bus-fanout (native) protocol', () => {
    conformanceSuite(nativeSidecar);
});

/**
 * R6, the divergence risk: one contract, two sidecar implementations (plus the
 * runner's gst probe). Feeding the SAME ladder to both must produce the same
 * timeline buffer for buffer — only the anchor may differ, since that is the
 * one clock-derived number in the mapping.
 */
describe.skipIf(!havePython || !haveNative)('python/native stamping parity', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.splice(0).forEach((fn) => fn());
    });

    /**
     * The EVENT contract, not just the arithmetic. Both sidecars report an
     * in-place re-anchor to the engine, and until this was pinned the C++ pair
     * emitted four fields where python emitted six: `lastPts90k` and
     * `deltaTicks` — the only two that say what the jump actually was — were
     * missing, so the same event meant something different depending on which
     * implementation produced it. Field NAMES and the implementation-independent
     * VALUES must match; only `anchorNs` may differ, being clock-derived.
     */
    it('both implementations report a re-anchor with identical fields', async () => {
        // A +10 min jump on an INTERLEAVED pair, as any real A/V producer is:
        // the watch wants a second anomalous buffer before it believes a
        // discontinuity, and the confirmation lands one buffer later — with
        // the two steps in between accumulated into the delta, which is why
        // the expected jump is JUMP + 2 STEP.
        const JUMP = 90000n * 600n;
        const ladder = [
            ...rungs(3, 8_100_000n),
            ...rungs(3, 8_100_000n + 3n * STEP + JUMP),
        ];
        const fixture = ladderFixture(ladder, {
            pids: [0x100, 0x101],
            skew: 90n,
            packetsPerRung: BUFFER_BYTES / 188,
        });
        const reanchorOf = async (spawnSidecar: SpawnSidecar) => {
            const r = await rig(cleanups, spawnSidecar, ladder.length, ['--stamp-timeline']);
            const p = await producer(r.ingest);
            cleanups.push(() => p.destroy());
            p.write(fixture);
            return waitFor(
                () => r.sidecarEvents.find((e) => e.event === 'timeline_reanchor'),
                'a re-anchor event',
                15000,
            );
        };
        const py = await reanchorOf(pythonSidecar);
        const native = await reanchorOf(nativeSidecar);
        expect(Object.keys(native).sort()).toEqual(Object.keys(py).sort());
        expect(Object.keys(py).sort()).toEqual([
            'anchorNs',
            'count',
            'deltaTicks',
            'event',
            'lastPts90k',
            'pid',
            'refPts90k',
        ]);
        const { anchorNs: _pyAnchor, ...pyRest } = py;
        const { anchorNs: _nativeAnchor, ...nativeRest } = native;
        expect(nativeRest).toEqual(pyRest);
        // ...and the jump it names is the one the fixture contains. 0x100 both
        // reports and confirms it: the watch returns on the first anomalous
        // PES of a buffer, and on the next buffer that PID comes back coherent
        // from the epoch it proposed.
        expect(pyRest).toMatchObject({ pid: 0x100, count: 1 });
        expect(BigInt(pyRest.deltaTicks as number)).toBe(JUMP + 2n * STEP);
    }, 40000);

    /**
     * The drift loop's observability surface, which is the periodic stats line
     * rather than an event: a slew has no MOMENT to report at, it is a rate.
     * Both sidecars must publish it under the same key with the same fields —
     * `drift_stats()` in python, `mrts::drift_stats_json` in C++ — or a burn-in
     * chart would have to know which implementation stamped. And with the
     * contract OFF the key must be absent entirely: there is no stamper, and
     * the line has to stay what it was before any of this existed.
     */
    it('both implementations publish the drift loop in the stats line', async () => {
        const timelineOf = async (spawnSidecar: SpawnSidecar, extra: string[]) => {
            const r = await rig(cleanups, spawnSidecar, 1, extra);
            return waitFor(
                () => (r.sidecarEvents.find((e) => e.stats) as { stats: Record<string, unknown> })
                    ?.stats,
                'a stats line',
                15000,
            );
        };
        const py = await timelineOf(pythonSidecar, ['--stamp-timeline']);
        const native = await timelineOf(nativeSidecar, ['--stamp-timeline']);
        const keys = ['engageNs', 'marginNs', 'ppm', 'samples', 'slewNs', 'window'];
        expect(Object.keys(py.timeline as object).sort()).toEqual(keys);
        expect(Object.keys(native.timeline as object).sort()).toEqual(keys);
        // Nothing has drifted yet in a two-second test — what is pinned is that
        // both report a loop that is not yet measuring, identically.
        expect(native.timeline).toEqual(py.timeline);
        expect(py.timeline).toMatchObject({ ppm: 0, samples: 0, slewNs: 0, window: 10 });
        const off = await timelineOf(pythonSidecar, []);
        expect(off.timeline).toBeUndefined();
    }, 40000);

    it('both implementations map an identical ladder identically', async () => {
        // Steady rungs, a shed gap, then the 2^33 boundary — every case the
        // two ports could disagree on (modular delta, epoch unwrap, floor).
        const ladder = [
            ...rungs(4, PTS_WRAP - 10n * STEP),
            ...rungs(3, PTS_WRAP - 2n * STEP + 9n * STEP),
        ];
        const py = await stampLadder(cleanups, pythonSidecar, ladder, ['--stamp-timeline']);
        const native = await stampLadder(cleanups, nativeSidecar, ladder, ['--stamp-timeline']);
        const relative = (s: Stamped[]) => s.map((v) => v.pts - s[0].pts);
        expect(relative(native)).toEqual(relative(py));
        expect(relative(py)).toEqual(ladder.map((pes) => toNs(pes - ladder[0])));
    }, 30000);
});

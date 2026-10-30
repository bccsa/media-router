import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
    unixFdSrcSocketPaths,
    probeUnixSocket,
    waitForBusSockets,
    waitForLiveInputs,
} from './busSocketGate.js';
import type { LiveInputBranch } from '../plugins/PluginModule.js';

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
    it('waits until a late producer binds, reporting the pending path', async () => {
        const p = scratchPath();
        const pending: string[][] = [];
        setTimeout(() => void listen(p), 200);
        const ok = await waitForBusSockets([p], {
            onProgress: (x) => pending.push(x),
        });
        expect(ok).toBe(true);
        expect(pending[0]).toEqual([p]);
    });

    it('has NO deadline — a very late producer still opens the gate', async () => {
        // Longer than the old 10s deadline would be impractical in a unit
        // test; what matters is that no deadline parameter exists and the
        // wait keeps probing across several backoff rounds (250→500→1000ms)
        // without resolving false.
        const p = scratchPath();
        setTimeout(() => void listen(p), 1200);
        const ok = await waitForBusSockets([p], {});
        expect(ok).toBe(true);
    }, 10_000);

    it('aborts (resolves false) when shouldAbort trips, and stops probing', async () => {
        const p = scratchPath(); // never bound
        let aborted = false;
        let progressAfterAbort = 0;
        setTimeout(() => {
            aborted = true;
        }, 300);
        const ok = await waitForBusSockets([p], {
            shouldAbort: () => aborted,
            onProgress: () => {
                if (aborted) progressAfterAbort++;
            },
        });
        expect(ok).toBe(false);
        // Once aborted, the loop exits before probing again — no progress
        // callbacks may fire after the abort took effect.
        expect(progressAfterAbort).toBe(0);
    });

    it('resolves immediately (no onProgress) when all sockets are already up', async () => {
        const p = scratchPath();
        await listen(p);
        let reported = false;
        const ok = await waitForBusSockets([p], {
            onProgress: () => {
                reported = true;
            },
        });
        expect(ok).toBe(true);
        expect(reported).toBe(false);
    });

    it('reports only the still-pending subset', async () => {
        const up = scratchPath();
        const down = scratchPath();
        await listen(up);
        const pending: string[][] = [];
        let aborted = false;
        setTimeout(() => {
            aborted = true;
        }, 300);
        await waitForBusSockets([up, down], {
            shouldAbort: () => aborted,
            onProgress: (x) => pending.push(x),
        });
        expect(pending[0]).toEqual([down]);
    });
});

describe('waitForLiveInputs — an aggregator starts with the inputs that are there (B-192)', () => {
    const MIXER = 'audiomixer name=mixin ! capsfilter name=mixin_out ! fakesink';
    const input = (n: number, sock: string): LiveInputBranch => ({
        element: 'mixin',
        name: `mixin_in_${n}`,
        description: `unixfdsrc socket-path=${sock} ! queue ! mralignwatch name=aw${n}`,
    });
    /** Gives up the wait after `ms` (an input that never comes). */
    const until = (ms: number) => {
        let over = false;
        setTimeout(() => (over = true), ms);
        return () => over;
    };

    it('launches with the one input there, linked on the first pad, and names the others absent', async () => {
        const [a, b, c, d] = [scratchPath(), scratchPath(), scratchPath(), scratchPath()];
        await listen(c);
        const inputs = [input(0, a), input(1, b), input(2, c), input(3, d)];
        const gate = await waitForLiveInputs(
            { pipeline: MIXER, liveInputs: inputs, eosDrain: false },
            { shouldAbort: until(3000) },
        );
        expect(gate).not.toBeNull();
        expect(gate!.launch.pipeline).toBe(
            `${MIXER} ( name=mixin_in_2 ${inputs[2].description} ) ! mixin.sink_0`,
        );
        expect(gate!.absent).toEqual(['mixin_in_0', 'mixin_in_1', 'mixin_in_3']);
        // The runner gets a plain start: the field is the host's alone, the rest goes through.
        expect(gate!.launch).not.toHaveProperty('liveInputs');
        expect(gate!.launch.eosDrain).toBe(false);
    });

    it('every input there: all linked, in order, on consecutive pads', async () => {
        const [a, b] = [scratchPath(), scratchPath()];
        await listen(a);
        await listen(b);
        const inputs = [input(0, a), input(1, b)];
        const gate = await waitForLiveInputs({ pipeline: MIXER, liveInputs: inputs });
        expect(gate!.launch.pipeline).toBe(
            `${MIXER} ( name=mixin_in_0 ${inputs[0].description} ) ! mixin.sink_0` +
                ` ( name=mixin_in_1 ${inputs[1].description} ) ! mixin.sink_1`,
        );
        expect(gate!.absent).toEqual([]);
    });

    it('waits while none is there, naming every input, and opens on the first that comes', async () => {
        const [a, b] = [scratchPath(), scratchPath()];
        const pending: string[][] = [];
        setTimeout(() => void listen(b), 300);
        const gate = await waitForLiveInputs(
            { pipeline: MIXER, liveInputs: [input(0, a), input(1, b)] },
            { shouldAbort: until(3000), onProgress: (p) => pending.push(p) },
        );
        expect(pending[0]).toEqual([a, b]);
        expect(gate!.absent).toEqual(['mixin_in_0']);
        expect(gate!.launch.pipeline).toContain(`( name=mixin_in_1 `);
    });

    it("still waits for every socket of the pipeline's own, and for all of an input's", async () => {
        const [own, a1, a2] = [scratchPath(), scratchPath(), scratchPath()];
        await listen(a1);
        const two: LiveInputBranch = {
            element: 'mixin',
            name: 'mixin_in_0',
            description: `unixfdsrc socket-path=${a1} ! q. unixfdsrc socket-path=${a2} ! q.`,
        };
        const pending: string[][] = [];
        const gate = await waitForLiveInputs(
            { pipeline: `unixfdsrc socket-path=${own} ! ${MIXER}`, liveInputs: [two] },
            { shouldAbort: until(600), onProgress: (p) => pending.push(p) },
        );
        expect(gate).toBeNull();
        expect(pending[0]).toEqual([own, a2]);
    });
});

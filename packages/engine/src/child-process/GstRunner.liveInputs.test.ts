import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import type { ControlIpcMessage } from '@media-router/shared-types';

/**
 * B-192: the gate of an aggregator with `liveInputs` launches with the inputs whose producer
 * sockets accept instead of waiting for all of them, says which it left out, and a relaunch
 * (which replays the stored start) chooses again. Python is faked; the sockets are real.
 */
vi.mock('./PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./PythonProcess.js')>()),
    PythonProcess: (await import('./testing/FakePythonProcess.js')).FakePythonProcess,
}));
import { FakePythonProcess } from './testing/FakePythonProcess.js';

import { GstRunner } from './GstRunner.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, budgetMs = 4000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(25);
    }
    return cond();
}

const MIXER = 'audiomixer name=mixin ! capsfilter name=mixin_out ! fakesink';

describe('GstRunner — live inputs: launch with the sources that run (B-192)', () => {
    let runner: GstRunner;
    let sent: ControlIpcMessage[];
    let servers: Server[];
    let paths: string[];
    let seq = 0;

    const socketPath = (tag: string): string => {
        const p = `/tmp/gate-li-${process.pid}-${++seq}-${tag}.sock`;
        paths.push(p);
        return p;
    };
    const listen = async (path: string): Promise<void> => {
        const srv = createServer(() => {});
        servers.push(srv);
        await new Promise<void>((resolve) => srv.listen(path, () => resolve()));
    };
    const input = (n: number, sock: string) => ({
        element: 'mixin',
        name: `mixin_in_${n}`,
        description: `unixfdsrc socket-path=${sock} ! mralignwatch name=aw${n}`,
    });
    const send = (msg: ControlIpcMessage): void => runner.handleControlMessage(msg);
    const events = (action: string) =>
        sent.filter((m) => m.type === 'event' && m.action === action).map((m) => m.data);

    beforeEach(() => {
        FakePythonProcess.reset();
        sent = [];
        servers = [];
        paths = [];
        runner = new GstRunner('/nonexistent/python-runner.py', {
            post: (msg) => void sent.push(msg),
            exit: () => {},
        });
    });

    afterEach(async () => {
        send({ id: 'stop-z', type: 'request', action: 'stopPipeline', data: {} });
        for (const srv of servers) await new Promise((r) => srv.close(r));
        for (const p of paths) {
            try {
                unlinkSync(p);
            } catch {
                /* never bound */
            }
        }
    });

    it('four inputs, one running: launches at once with that one and names the other three', async () => {
        const socks = [0, 1, 2, 3].map((n) => socketPath(`in${n}`));
        await listen(socks[1]);
        const inputs = socks.map((s, n) => input(n, s));
        send({
            id: 'start-1',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: MIXER, liveInputs: inputs, restartOnError: true },
        });
        expect(await waitUntil(() => FakePythonProcess.spawned.length === 1)).toBe(true);
        const opts = FakePythonProcess.last().startOpts!;
        expect(opts.pipeline).toBe(
            `${MIXER} ( name=mixin_in_1 ${inputs[1].description} ) ! mixin.sink_0`,
        );
        expect(opts).not.toHaveProperty('liveInputs');
        // The gate opens naming what this launch goes without, before the launch itself.
        expect(events('busGate').at(-1)).toEqual({
            pending: [],
            absent: ['mixin_in_0', 'mixin_in_2', 'mixin_in_3'],
        });
        const order = sent.filter((m) => m.type === 'event').map((m) => m.action);
        expect(order.lastIndexOf('busGate')).toBeLessThan(order.indexOf('pipelineLaunched'));
    });

    it('none running: waits naming every input, launches with the first that comes', async () => {
        const socks = [socketPath('a'), socketPath('b')];
        send({
            id: 'start-1',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: MIXER, liveInputs: socks.map((s, n) => input(n, s)) },
        });
        await sleep(300);
        expect(FakePythonProcess.spawned).toHaveLength(0);
        expect(events('busGate')[0]).toEqual({ pending: socks });
        await listen(socks[0]);
        expect(await waitUntil(() => FakePythonProcess.spawned.length === 1)).toBe(true);
        expect(events('busGate').at(-1)).toEqual({ pending: [], absent: ['mixin_in_1'] });
    });

    it('a relaunch replays the stored start and chooses again: a source back since is in', async () => {
        const socks = [socketPath('a'), socketPath('b')];
        await listen(socks[0]);
        send({
            id: 'start-1',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: MIXER, liveInputs: socks.map((s, n) => input(n, s)) },
        });
        expect(await waitUntil(() => FakePythonProcess.spawned.length === 1)).toBe(true);
        await listen(socks[1]);
        send({ id: 'rl-1', type: 'request', action: 'restartPipeline', data: { reason: 't' } });
        expect(await waitUntil(() => FakePythonProcess.spawned.length === 2)).toBe(true);
        expect(FakePythonProcess.last().startOpts!.pipeline).toContain('mixin.sink_1');
        expect(events('busGate').at(-1)).toEqual({ pending: [], absent: [] });
    });

    it('a plain start reports an empty absent list when its gate opens', async () => {
        const sock = socketPath('plain');
        await listen(sock);
        send({
            id: 'start-1',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: `unixfdsrc socket-path=${sock} ! fakesink` },
        });
        expect(await waitUntil(() => FakePythonProcess.spawned.length === 1)).toBe(true);
        expect(events('busGate').at(-1)).toEqual({ pending: [], absent: [] });
        expect(FakePythonProcess.last().startOpts!.pipeline).toBe(
            `unixfdsrc socket-path=${sock} ! fakesink`,
        );
    });
});

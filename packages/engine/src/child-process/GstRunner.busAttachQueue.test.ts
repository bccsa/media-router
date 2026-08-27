import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import type { ControlIpcMessage } from '@media-router/shared-types';

/**
 * A `busAttach` that arrives while the runner's INPUT socket gate is still
 * holding the pipeline back must be QUEUED, not dropped.
 *
 * The gate waits indefinitely (`busSocketGate`) and spawns no Python while it
 * waits, so `this.python?.sendCommand(...)` was a silent no-op for the whole
 * wait. The only other path that ever attaches a consumer's edge is the
 * producer's PLAYING edge (`BusFanoutCoordinator.reattachProducer`), so every
 * consumer of a producer that gates for minutes — or never reaches PLAYING —
 * sat on "Waiting for producer bus socket(s)" against an edge socket nobody was
 * going to create.
 *
 * The Python child is faked here: what is under test is the queue/flush/cancel
 * bookkeeping and the ORDER the commands reach Python in (`start` first, then
 * the attaches, because Python executes its command stream in order).
 */
const h = vi.hoisted(() => {
    class FakePythonProcess {
        static spawned: FakePythonProcess[] = [];
        readonly commands: Record<string, unknown>[] = [];
        constructor(readonly options: Record<string, unknown>) {
            FakePythonProcess.spawned.push(this);
        }
        get pid(): number {
            return 4242;
        }
        start(): void {
            // The real PythonProcess writes the `start` command synchronously
            // at the end of start() — mirrored so command order is observable.
            this.commands.push({ cmd: 'start' });
        }
        sendCommand(cmd: Record<string, unknown>): void {
            this.commands.push(cmd);
        }
        stop(): void {}
        kill(): void {}
        emergencyKill(): void {}
    }
    return { FakePythonProcess };
});

vi.mock('./PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./PythonProcess.js')>()),
    PythonProcess: h.FakePythonProcess,
}));

import { GstRunner } from './GstRunner.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds (the gate's probe interval is 250 ms and backs off). */
async function waitUntil(cond: () => boolean, budgetMs = 4000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(25);
    }
    return cond();
}

describe('GstRunner — gated busAttach queue', () => {
    let runner: GstRunner;
    let originalSend: typeof process.send;
    let originalConnected: PropertyDescriptor | undefined;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let servers: Server[];
    let paths: string[];
    let seq = 0;

    const socketPath = (tag: string): string => {
        const p = `/tmp/gate-q-${process.pid}-${++seq}-${tag}.sock`;
        paths.push(p);
        return p;
    };

    /** Open a real listener so the connect-probe gate resolves. */
    const listen = async (path: string): Promise<void> => {
        const srv = createServer(() => {});
        servers.push(srv);
        await new Promise<void>((resolve) => srv.listen(path, () => resolve()));
    };

    const send = (msg: ControlIpcMessage): void => runner.handleControlMessage(msg);
    const startGated = (input: string): void =>
        send({
            id: 'start-1',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: `unixfdsrc socket-path=${input} ! fakesink`, restartOnError: false },
        });
    const busAttach = (tee: string, socket: string): void =>
        send({ id: 'a', type: 'event', action: 'busAttach', data: { tee, socket } });
    const busDetach = (socket: string): void =>
        send({ id: 'd', type: 'event', action: 'busDetach', data: { socket } });

    const spawned = (): InstanceType<typeof h.FakePythonProcess>[] =>
        h.FakePythonProcess.spawned as InstanceType<typeof h.FakePythonProcess>[];
    const queued = (): string[] => [
        ...(
            runner as unknown as { queuedBusAttaches: Map<string, string> }
        ).queuedBusAttaches.keys(),
    ];

    beforeEach(() => {
        h.FakePythonProcess.spawned = [];
        servers = [];
        paths = [];
        originalSend = process.send;
        originalConnected = Object.getOwnPropertyDescriptor(process, 'connected');
        Object.defineProperty(process, 'connected', { value: true, configurable: true });
        process.send = (() => true) as unknown as typeof process.send;
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        runner = new GstRunner('/nonexistent/python-runner.py');
    });

    afterEach(async () => {
        // Cancel any still-waiting gate — its probe loop is immortal otherwise.
        send({ id: 'stop-z', type: 'request', action: 'stopPipeline', data: {} });
        for (const srv of servers) await new Promise((r) => srv.close(r));
        for (const p of paths) {
            try {
                unlinkSync(p);
            } catch {
                /* never bound */
            }
        }
        exitSpy.mockRestore();
        if (originalConnected) Object.defineProperty(process, 'connected', originalConnected);
        process.send = originalSend;
    });

    it('queues attaches that arrive while gated and flushes them, in order, at launch', async () => {
        const input = socketPath('in');
        const edgeA = socketPath('edge-a');
        const edgeB = socketPath('edge-b');

        startGated(input);
        await sleep(50);
        busAttach('busout_41000', edgeA);
        busAttach('busout_41000', edgeB);

        // Still gated: nothing spawned, both attaches held rather than dropped.
        expect(spawned()).toHaveLength(0);
        expect(queued()).toEqual([edgeA, edgeB]);

        await listen(input);
        expect(await waitUntil(() => spawned().length === 1)).toBe(true);

        // `start` first (the pipeline must exist before an attach can find its
        // tee), then the attaches in the order the coordinator sent them.
        expect(spawned()[0]!.commands).toEqual([
            { cmd: 'start' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeA },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeB },
        ]);
        expect(queued()).toEqual([]);
    });

    it('collapses a duplicate attach on one edge without losing its queue position', async () => {
        const input = socketPath('in');
        const edgeA = socketPath('edge-a');
        const edgeB = socketPath('edge-b');

        startGated(input);
        await sleep(50);
        busAttach('busout_41000', edgeA);
        busAttach('busout_41000', edgeB);
        busAttach('busout_41000', edgeA); // re-apply / coordinator reconcile
        expect(queued()).toEqual([edgeA, edgeB]);

        await listen(input);
        expect(await waitUntil(() => spawned().length === 1)).toBe(true);
        expect(spawned()[0]!.commands).toEqual([
            { cmd: 'start' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeA },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeB },
        ]);
    });

    it('busDetach cancels a queued attach — the flush must not rebuild a torn-down edge', async () => {
        const input = socketPath('in');
        const edgeA = socketPath('edge-a');
        const edgeB = socketPath('edge-b');

        startGated(input);
        await sleep(50);
        busAttach('busout_41000', edgeA);
        busAttach('busout_41000', edgeB);
        busDetach(edgeA);
        expect(queued()).toEqual([edgeB]);

        await listen(input);
        expect(await waitUntil(() => spawned().length === 1)).toBe(true);
        expect(spawned()[0]!.commands).toEqual([
            { cmd: 'start' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeB },
        ]);
    });

    it('a newer start during the gate drops the superseded epoch’s queue', async () => {
        const inputOld = socketPath('in-old');
        const inputNew = socketPath('in-new');
        const edgeA = socketPath('edge-a');
        const edgeB = socketPath('edge-b');

        startGated(inputOld);
        await sleep(50);
        busAttach('busout_41000', edgeA);
        expect(queued()).toEqual([edgeA]);

        // Epoch bump: the queued attach belongs to a topology that is gone.
        // The parent re-attaches on the next PLAYING edge.
        startGated(inputNew);
        expect(queued()).toEqual([]);
        busAttach('busout_41000', edgeB);

        await listen(inputNew);
        expect(await waitUntil(() => spawned().length === 1)).toBe(true);
        expect(spawned()[0]!.commands).toEqual([
            { cmd: 'start' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeB },
        ]);
    });

    it('stopPipeline during the gate clears the queue (nothing to replay)', async () => {
        const input = socketPath('in');
        const edgeA = socketPath('edge-a');

        startGated(input);
        await sleep(50);
        busAttach('busout_41000', edgeA);
        expect(queued()).toEqual([edgeA]);

        send({ id: 'stop-1', type: 'request', action: 'stopPipeline', data: {} });
        expect(queued()).toEqual([]);

        // Even if the producer socket appears now, the stopped epoch launches
        // nothing — so there is nobody to flush into either.
        await listen(input);
        await sleep(600);
        expect(spawned()).toHaveLength(0);
    });

    it('an ungated pipeline still sends attaches straight through', async () => {
        const edgeA = socketPath('edge-a');
        send({
            id: 'start-p',
            type: 'request',
            action: 'startPipeline',
            data: { pipeline: 'videotestsrc ! fakesink', restartOnError: false },
        });
        expect(spawned()).toHaveLength(1);
        busAttach('busout_41000', edgeA);
        expect(queued()).toEqual([]);
        expect(spawned()[0]!.commands).toEqual([
            { cmd: 'start' },
            { cmd: 'bus_attach', tee: 'busout_41000', socket: edgeA },
        ]);
    });
});

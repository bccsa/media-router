import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { MpegTsBusExecutor } from './MpegTsBusExecutor.js';
import { busEdgeSocketPath } from '../plugins/busHelpers.js';
import type { Connection } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

const PORT = 40001;

function conn(id: string, source = 'input-A'): Connection {
    return {
        id,
        sourceModuleId: source,
        sourcePortId: 'mpegts-out',
        sinkModuleId: 'splitter-1',
        sinkPortId: 'mpegts-in',
        streamType: 'muxed/mpegts',
    } as Connection;
}

function sinkStub(opts: { swapCapable?: boolean; native?: boolean } = {}) {
    const busReinput = vi.fn(async () => {});
    const sink = {
        running: true,
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        setHealth: vi.fn(),
        refreshPipelineDescription: vi.fn(async () => true),
        getLiveInputSwap: vi.fn(() => ((opts.swapCapable ?? true) ? { element: 'netin' } : null)),
        // native sink = no gst child; the swap RPC rides its own controller
        // (ModuleInstance.getLiveSwapTarget falls back to the child for gst).
        getChildProcess: vi.fn(() => (opts.native ? null : { busReinput })),
        getLiveSwapTarget: vi.fn(() => ({ busReinput })),
        getDynamicPorts: vi.fn(() => []),
    } as unknown as ModuleInstance;
    return { sink, busReinput };
}

function makeExecutor(sink: ModuleInstance) {
    const fanout = { attach: vi.fn(), detach: vi.fn() };
    const executor = new MpegTsBusExecutor(
        () => sink,
        () => PORT,
        (c) => c.id,
        undefined,
        fanout as never,
    );
    return { executor, fanout };
}

describe('MpegTsBusExecutor live input swap', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('defers teardown for a swap-capable running sink: no detach, no restart, warning set', async () => {
        const { sink } = sinkStub();
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            false,
        );

        expect(fanout.detach).not.toHaveBeenCalled();
        expect((sink as any).stop).not.toHaveBeenCalled();
        expect((sink as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('Input disconnect pending'),
        );
    });

    it('window expiry runs the classic teardown (detach + stop/start)', async () => {
        const { sink } = sinkStub();
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            false,
        );
        await vi.advanceTimersByTimeAsync(16_000);

        expect(fanout.detach).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).toHaveBeenCalledTimes(1);
        expect((sink as any).start).toHaveBeenCalledTimes(1);
    });

    it("non-capable sink keeps today's behaviour: immediate detach + restart", async () => {
        const { sink } = sinkStub({ swapCapable: false });
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            false,
        );

        expect(fanout.detach).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).toHaveBeenCalledTimes(1);
        expect((sink as any).start).toHaveBeenCalledTimes(1);
    });

    it('stops the consumer BEFORE detaching the producer branch', async () => {
        // Detaching first closed the edge socket under a running consumer, so
        // every disconnect killed it by `unixfdsrc` "Internal data stream
        // error" — the one teardown shape the runner cannot EOS-drain, which
        // left the Pi's HEVC decoder wedged mid-decode for the next session.
        const { sink } = sinkStub({ swapCapable: false });
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            false,
        );

        const stoppedAt = (sink as any).stop.mock.invocationCallOrder[0];
        const startedAt = (sink as any).start.mock.invocationCallOrder[0];
        const detachedAt = fanout.detach.mock.invocationCallOrder[0];
        expect(stoppedAt).toBeLessThan(detachedAt);
        // The idle restart completes first too: its buildPipeline returns null
        // (the connection record is already gone), so nothing re-attaches to
        // the socket we then detach.
        expect(startedAt).toBeLessThan(detachedAt);
    });

    it('keeps that order on the deferred swap-window expiry', async () => {
        const { sink } = sinkStub();
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            false,
        );
        await vi.advanceTimersByTimeAsync(16_000);

        expect((sink as any).stop.mock.invocationCallOrder[0]).toBeLessThan(
            fanout.detach.mock.invocationCallOrder[0],
        );
    });

    it('skipModuleRestart still detaches immediately and never defers', async () => {
        const { sink } = sinkStub();
        const { executor, fanout } = makeExecutor(sink);

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old'),
            true,
        );

        expect(fanout.detach).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).not.toHaveBeenCalled();
    });
});

describe('MpegTsBusExecutor swap execution (real edge socket)', () => {
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await new Promise((r) => server!.close(r));
            server = null;
        }
    });

    it('remove-then-add swaps live: bus_reinput lands, old edge detached, sink never restarted', async () => {
        const { sink, busReinput } = sinkStub();
        const { executor, fanout } = makeExecutor(sink);
        const newConn = conn('input-B:mpegts-out-splitter-1:mpegts-in', 'input-B');

        // The producer edge socket the swap path waits on.
        const edgePath = busEdgeSocketPath(PORT, newConn.id);
        server = createServer();
        await new Promise<void>((res) => server!.listen(edgePath, res));

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old', 'input-A'),
            false,
        );
        const handle = await executor.execute(newConn);

        expect(handle).toMatchObject({ connectionId: newConn.id, busChannel: PORT });
        expect(busReinput).toHaveBeenCalledWith('netin', edgePath);
        expect((sink as any).refreshPipelineDescription).toHaveBeenCalled();
        // Old edge detached exactly once, new edge attached, no sink restart.
        expect(fanout.detach).toHaveBeenCalledTimes(1);
        expect(fanout.attach).toHaveBeenCalledWith(newConn);
        expect((sink as any).stop).not.toHaveBeenCalled();
        expect((sink as any).start).not.toHaveBeenCalled();
        // Pending-window warning cleared on success.
        expect((sink as any).setHealth).toHaveBeenCalledWith('ok');
    });

    it('completes the swap for a NATIVE sink (no gst child, controller target)', async () => {
        const { sink, busReinput } = sinkStub({ native: true });
        const { executor, fanout } = makeExecutor(sink);
        const newConn = conn('input-B:mpegts-out-splitter-1:mpegts-in', 'input-B');

        const edgePath = busEdgeSocketPath(PORT, newConn.id);
        server = createServer();
        await new Promise<void>((res) => server!.listen(edgePath, res));

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old', 'input-A'),
            false,
        );
        const handle = await executor.execute(newConn);

        expect(handle).toMatchObject({ connectionId: newConn.id, busChannel: PORT });
        expect(busReinput).toHaveBeenCalledWith('netin', edgePath);
        expect((sink as any).stop).not.toHaveBeenCalled();
        expect((sink as any).start).not.toHaveBeenCalled();
    });

    it('falls back to the classic restart when bus_reinput fails', async () => {
        const { sink } = sinkStub();
        (sink.getLiveSwapTarget as any) = vi.fn(() => ({
            busReinput: vi.fn(async () => {
                throw new Error('runner rejected');
            }),
        }));
        const { executor, fanout } = makeExecutor(sink);
        const newConn = conn('input-B:mpegts-out-splitter-1:mpegts-in', 'input-B');

        const edgePath = busEdgeSocketPath(PORT, newConn.id);
        server = createServer();
        await new Promise<void>((res) => server!.listen(edgePath, res));

        await executor.teardown(
            { connectionId: 'old', type: 'bus', busChannel: PORT },
            conn('old', 'input-A'),
            false,
        );
        const handle = await executor.execute(newConn);

        // Old edge detached by the failure path, then the classic restart ran.
        expect(fanout.detach).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).toHaveBeenCalledTimes(1);
        expect((sink as any).start).toHaveBeenCalledTimes(1);
        expect(handle).toMatchObject({ connectionId: newConn.id, busChannel: PORT });
    });
});

describe('MpegTsBusExecutor materializeProducerPort', () => {
    function producerStub(opts: { native?: boolean; hasTarget?: boolean } = {}) {
        return {
            running: true,
            stop: vi.fn(async () => {}),
            start: vi.fn(async () => {}),
            getChildProcess: vi.fn(() => (opts.native ? null : { busReinput: vi.fn() })),
            getBusAttachTarget: vi.fn(() =>
                (opts.hasTarget ?? true)
                    ? { sendBusAttach: vi.fn(), sendBusDetach: vi.fn() }
                    : null,
            ),
            getDynamicPorts: vi.fn(() => [{ id: 'pid-0x65', direction: 'output' }]),
        } as unknown as ModuleInstance;
    }

    function lateWireConn(): Connection {
        return {
            id: 'late',
            sourceModuleId: 'splitter-1',
            sourcePortId: 'pid-0x65',
            sinkModuleId: 'decoder-1',
            sinkPortId: 'mpegts-in',
            streamType: 'muxed/mpegts',
        } as Connection;
    }

    function makeMaterializeExecutor(producer: ModuleInstance, sink: ModuleInstance) {
        // Port resolves only AFTER the producer restarted (the bounce built it).
        const getUdpPort = vi.fn((moduleId: string) =>
            moduleId === 'splitter-1' && (producer.start as any).mock.calls.length > 0
                ? PORT
                : undefined,
        );
        const modules: Record<string, ModuleInstance> = {
            'splitter-1': producer,
            'decoder-1': sink,
        };
        const fanout = { attach: vi.fn(), detach: vi.fn() };
        const executor = new MpegTsBusExecutor(
            (id) => modules[id],
            getUdpPort,
            (c) => c.id,
            undefined,
            fanout as never,
        );
        return executor;
    }

    it('bounces a NATIVE producer (no gst child, live attach target) for a late-wired port', async () => {
        const producer = producerStub({ native: true });
        const { sink } = sinkStub({ swapCapable: false });
        const executor = makeMaterializeExecutor(producer, sink);

        const handle = await executor.execute(lateWireConn());

        expect((producer as any).stop).toHaveBeenCalledTimes(1);
        expect((producer as any).start).toHaveBeenCalledTimes(1);
        expect(handle).toMatchObject({ busChannel: PORT });
    });

    it('never bounces a running-but-idle producer (no child, no attach target)', async () => {
        const producer = producerStub({ native: true, hasTarget: false });
        const { sink } = sinkStub({ swapCapable: false });
        const executor = makeMaterializeExecutor(producer, sink);

        await expect(executor.execute(lateWireConn())).rejects.toThrow(/not assigned/);
        expect((producer as any).start).not.toHaveBeenCalled();
    });
});

// --- Live input branches (#787): aggregator sinks add/remove one branch live ---

function aggregatorSink(
    opts: { launched?: boolean; branch?: boolean; description?: boolean } = {},
) {
    const busInputAdd = vi.fn(async () => {});
    const busInputRemove = vi.fn(async () => {});
    const sink = {
        running: true,
        stop: vi.fn(async () => {}),
        start: vi.fn(async () => {}),
        setHealth: vi.fn(),
        refreshPipelineDescription: vi.fn(async () => true),
        getLiveInputSwap: vi.fn(() => null),
        getLiveSwapTarget: vi.fn(() => null),
        noteLiveInputRestored: vi.fn(),
        getLiveInputBranch: vi.fn((_port: string, connId: string) =>
            (opts.branch ?? true)
                ? {
                      element: 'mixin',
                      name: `mixin_in_${connId}`,
                      ...((opts.description ?? true)
                          ? { description: `unixfdsrc socket-path=/x-${connId} ! queue` }
                          : {}),
                  }
                : null,
        ),
        getLiveInputBranchTarget: vi.fn(() => ({ busInputAdd, busInputRemove })),
        getChildProcess: vi.fn(() => ({
            pipelineLaunchedAt: (opts.launched ?? true) ? 1000 : undefined,
        })),
        getDynamicPorts: vi.fn(() => []),
    } as unknown as ModuleInstance;
    return { sink, busInputAdd, busInputRemove };
}

function makeLiveExecutor(sink: ModuleInstance, remaining = 1) {
    const fanout = { attach: vi.fn(), detach: vi.fn() };
    const countBusInputs = vi.fn(() => remaining);
    const executor = new MpegTsBusExecutor(
        () => sink,
        () => PORT,
        (c) => c.id,
        undefined,
        fanout as never,
        countBusInputs,
    );
    return { executor, fanout, countBusInputs };
}

function mixConn(id: string): Connection {
    return {
        id,
        sourceModuleId: 'src-' + id,
        sourcePortId: 'out-0',
        sinkModuleId: 'mixer-1',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
    } as Connection;
}

describe('MpegTsBusExecutor live input branches', () => {
    let server: Server | null = null;

    afterEach(async () => {
        if (server) {
            await new Promise((r) => server!.close(r));
            server = null;
        }
    });

    async function listenEdge(c: Connection): Promise<string> {
        const edge = busEdgeSocketPath(PORT, c.id);
        server = createServer();
        await new Promise<void>((res) => server!.listen(edge, res));
        return edge;
    }

    it('adds the branch on a running aggregator: no stop/start, description refreshed', async () => {
        const { sink, busInputAdd } = aggregatorSink();
        const { executor, fanout } = makeLiveExecutor(sink);
        const c = mixConn('c2');
        await listenEdge(c);

        const handle = await executor.execute(c);

        expect(handle).toMatchObject({ connectionId: 'c2', type: 'bus', busChannel: PORT });
        expect(fanout.attach).toHaveBeenCalledWith(c);
        expect(busInputAdd).toHaveBeenCalledWith({
            element: 'mixin',
            name: 'mixin_in_c2',
            description: 'unixfdsrc socket-path=/x-c2 ! queue',
        });
        expect((sink as any).refreshPipelineDescription).toHaveBeenCalled();
        expect((sink as any).stop).not.toHaveBeenCalled();
        expect((sink as any).start).not.toHaveBeenCalled();
    });

    it('keeps the classic restart while the sink has no launched pipeline (gating / mid-restart)', async () => {
        const { sink, busInputAdd } = aggregatorSink({ launched: false });
        const { executor } = makeLiveExecutor(sink);

        await executor.execute(mixConn('c3'));

        expect(busInputAdd).not.toHaveBeenCalled();
        expect((sink as any).stop).toHaveBeenCalled();
        expect((sink as any).start).toHaveBeenCalled();
    });

    it('falls back to the classic restart when the runner refuses the add', async () => {
        const { sink, busInputAdd } = aggregatorSink();
        busInputAdd.mockRejectedValueOnce(new Error("element 'mixin' not found"));
        const { executor } = makeLiveExecutor(sink);
        const c = mixConn('c4');
        await listenEdge(c);

        const handle = await executor.execute(c);

        expect(handle).toMatchObject({ connectionId: 'c4' });
        expect(busInputAdd).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).toHaveBeenCalled();
        expect((sink as any).start).toHaveBeenCalled();
    });

    it('a sink without the hook is untouched by the live path', async () => {
        const { sink, busInputAdd } = aggregatorSink({ branch: false });
        const { executor } = makeLiveExecutor(sink);

        await executor.execute(mixConn('c5'));

        expect(busInputAdd).not.toHaveBeenCalled();
        expect((sink as any).start).toHaveBeenCalled();
    });

    it('removes the branch live when other inputs remain: branch first, then the edge, no restart', async () => {
        const { sink, busInputRemove } = aggregatorSink({ description: false });
        const { executor, fanout } = makeLiveExecutor(sink, 1);
        const c = mixConn('c6');
        const order: string[] = [];
        busInputRemove.mockImplementation(async () => {
            order.push('remove');
        });
        fanout.detach.mockImplementation(() => order.push('detach'));

        await executor.teardown({ connectionId: 'c6', type: 'bus', busChannel: PORT }, c, false);

        expect(busInputRemove).toHaveBeenCalledWith({ element: 'mixin', name: 'mixin_in_c6' });
        expect(order).toEqual(['remove', 'detach']);
        expect((sink as any).refreshPipelineDescription).toHaveBeenCalled();
        expect((sink as any).stop).not.toHaveBeenCalled();
    });

    it('the last input on the port keeps the classic teardown (the module must idle)', async () => {
        const { sink, busInputRemove } = aggregatorSink({ description: false });
        const { executor, fanout } = makeLiveExecutor(sink, 0);

        await executor.teardown(
            { connectionId: 'c7', type: 'bus', busChannel: PORT },
            mixConn('c7'),
            false,
        );

        expect(busInputRemove).not.toHaveBeenCalled();
        expect((sink as any).stop).toHaveBeenCalled();
        expect((sink as any).start).toHaveBeenCalled();
        expect(fanout.detach).toHaveBeenCalled();
    });

    it('the last branch is never removed live, whoever asks — a stale replay copy would gate on it', async () => {
        const { sink, busInputRemove } = aggregatorSink({ description: false });
        const { executor, fanout } = makeLiveExecutor(sink, 0);

        await executor.teardown(
            { connectionId: 'c8', type: 'bus', busChannel: PORT },
            mixConn('c8'),
            true,
        );

        expect(busInputRemove).not.toHaveBeenCalled();
        expect(fanout.detach).toHaveBeenCalled();
        // skipModuleRestart: the caller handles the module, so no restart here either.
        expect((sink as any).stop).not.toHaveBeenCalled();
    });

    it('a refused remove falls back to the classic teardown', async () => {
        const { sink, busInputRemove } = aggregatorSink({ description: false });
        busInputRemove.mockRejectedValueOnce(new Error('branch not found'));
        const { executor, fanout } = makeLiveExecutor(sink, 1);

        await executor.teardown(
            { connectionId: 'c9', type: 'bus', busChannel: PORT },
            mixConn('c9'),
            false,
        );

        expect((sink as any).stop).toHaveBeenCalled();
        expect((sink as any).start).toHaveBeenCalled();
        expect(fanout.detach).toHaveBeenCalledTimes(1);
    });

    it('relinkLiveInput: drops the branch, waits for the new edge, re-adds, withdraws the lost-input warning', async () => {
        const { sink, busInputAdd, busInputRemove } = aggregatorSink();
        const { executor } = makeLiveExecutor(sink);
        const c = mixConn('c10');
        await listenEdge(c);

        expect(await executor.relinkLiveInput(c)).toBe(true);

        expect(busInputRemove).toHaveBeenCalledWith(
            expect.objectContaining({ element: 'mixin', name: 'mixin_in_c10' }),
        );
        expect(busInputAdd).toHaveBeenCalledWith(expect.objectContaining({ name: 'mixin_in_c10' }));
        expect(busInputRemove.mock.invocationCallOrder[0]).toBeLessThan(
            busInputAdd.mock.invocationCallOrder[0],
        );
        expect((sink as any).refreshPipelineDescription).toHaveBeenCalled();
        // Only the lost-input warning is withdrawn — never a blanket health reset.
        expect((sink as any).noteLiveInputRestored).toHaveBeenCalledWith('mixin_in_c10');
        expect((sink as any).setHealth).not.toHaveBeenCalled();
        expect((sink as any).stop).not.toHaveBeenCalled();
    });

    it('relinkLiveInput: false for a sink without a launched pipeline or when the add fails', async () => {
        const gating = aggregatorSink({ launched: false });
        expect(await makeLiveExecutor(gating.sink).executor.relinkLiveInput(mixConn('c11'))).toBe(
            false,
        );
        expect(gating.busInputAdd).not.toHaveBeenCalled();

        const failing = aggregatorSink();
        failing.busInputAdd.mockRejectedValueOnce(new Error('link failed'));
        const c = mixConn('c12');
        await listenEdge(c);
        expect(await makeLiveExecutor(failing.sink).executor.relinkLiveInput(c)).toBe(false);
    });

    it('a late producer socket does not restart the sink: the branch is added anyway and the runner contains it', async () => {
        const { sink, busInputAdd } = aggregatorSink();
        const { executor } = makeLiveExecutor(sink);
        const c = mixConn('c13'); // no edge socket listening

        const handle = await executor.execute(c);

        expect(handle).toMatchObject({ connectionId: 'c13' });
        expect(busInputAdd).toHaveBeenCalledTimes(1);
        expect((sink as any).stop).not.toHaveBeenCalled();
    }, 15_000);

    it('replaceLiveInput: remove + add in place, no detach, no restart', async () => {
        const { sink, busInputAdd, busInputRemove } = aggregatorSink();
        const { executor, fanout } = makeLiveExecutor(sink);

        expect(await executor.replaceLiveInput(mixConn('c14'))).toBe(true);

        expect(busInputRemove.mock.invocationCallOrder[0]).toBeLessThan(
            busInputAdd.mock.invocationCallOrder[0],
        );
        expect(fanout.detach).not.toHaveBeenCalled();
        expect((sink as any).stop).not.toHaveBeenCalled();
        expect((sink as any).refreshPipelineDescription).toHaveBeenCalled();
    });
});

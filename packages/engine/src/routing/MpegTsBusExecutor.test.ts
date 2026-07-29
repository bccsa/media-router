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
        getLiveInputSwap: vi.fn(() =>
            (opts.swapCapable ?? true) ? { element: 'netin' } : null,
        ),
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

    it('non-capable sink keeps today\'s behaviour: immediate detach + restart', async () => {
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
                (opts.hasTarget ?? true) ? { sendBusAttach: vi.fn(), sendBusDetach: vi.fn() } : null,
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

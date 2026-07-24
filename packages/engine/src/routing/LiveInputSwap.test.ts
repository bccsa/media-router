import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingInputSwaps, SWAP_WINDOW_MS, performLiveSwap } from './LiveInputSwap.js';
import type { Connection } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';

function conn(id: string, sink = 'splitter-1', port = 'mpegts-in'): Connection {
    return {
        id,
        sourceModuleId: `src-${id}`,
        sourcePortId: 'mpegts-out',
        sinkModuleId: sink,
        sinkPortId: port,
        streamType: 'muxed/mpegts',
    } as Connection;
}

describe('PendingInputSwaps', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('claim within the window cancels finalize and returns the entry', async () => {
        const swaps = new PendingInputSwaps();
        const finalize = vi.fn(async () => {});
        swaps.defer({ conn: conn('a') }, finalize);

        const claimed = swaps.claim(conn('b'));
        expect(claimed?.conn.id).toBe('a');
        expect(swaps.size).toBe(0);

        await vi.advanceTimersByTimeAsync(SWAP_WINDOW_MS + 1000);
        expect(finalize).not.toHaveBeenCalled();
    });

    it('expiry runs finalize exactly once and later claims miss', async () => {
        const swaps = new PendingInputSwaps();
        const finalize = vi.fn(async () => {});
        swaps.defer({ conn: conn('a') }, finalize);

        await vi.advanceTimersByTimeAsync(SWAP_WINDOW_MS + 1);
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(swaps.claim(conn('b'))).toBeNull();

        await vi.advanceTimersByTimeAsync(SWAP_WINDOW_MS);
        expect(finalize).toHaveBeenCalledTimes(1);
    });

    it('a second defer on the same sink:port finalizes the first immediately', async () => {
        const swaps = new PendingInputSwaps();
        const f1 = vi.fn(async () => {});
        const f2 = vi.fn(async () => {});
        swaps.defer({ conn: conn('a') }, f1);
        swaps.defer({ conn: conn('b') }, f2);

        expect(f1).toHaveBeenCalledTimes(1);
        expect(f2).not.toHaveBeenCalled();
        expect(swaps.claim(conn('c'))?.conn.id).toBe('b');
    });

    it('windows on different sink ports are independent', () => {
        const swaps = new PendingInputSwaps();
        swaps.defer({ conn: conn('a', 'splitter-1') }, async () => {});
        swaps.defer({ conn: conn('b', 'splitter-2') }, async () => {});
        expect(swaps.size).toBe(2);
        expect(swaps.claim(conn('x', 'splitter-2'))?.conn.id).toBe('b');
        expect(swaps.claim(conn('y', 'splitter-1'))?.conn.id).toBe('a');
    });
});

describe('performLiveSwap', () => {
    function sinkStub(overrides: Partial<Record<string, unknown>> = {}) {
        const busReinput = vi.fn(async () => {});
        const sink = {
            running: true,
            getLiveInputSwap: vi.fn(() => ({ element: 'netin' })),
            getChildProcess: vi.fn(() => ({ busReinput })),
            refreshPipelineDescription: vi.fn(async () => true),
            setHealth: vi.fn(),
            ...overrides,
        } as unknown as ModuleInstance;
        return { sink, busReinput };
    }

    it('detaches the old edge and returns false when the sink lost the capability', async () => {
        const { sink } = sinkStub({ getLiveInputSwap: vi.fn(() => null) });
        const detach = vi.fn();
        const ok = await performLiveSwap({
            sink,
            conn: conn('new'),
            oldConn: conn('old'),
            udpPort: 40001,
            busFanout: { detach } as never,
        });
        expect(ok).toBe(false);
        expect(detach).toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
    });

    it('falls back (false + old-edge detach) when the edge socket never appears', async () => {
        // No socket exists at the edge path in this test env, so the probe
        // loop times out — the failure path must detach the old edge.
        const { sink, busReinput } = sinkStub();
        const detach = vi.fn();
        const ok = await performLiveSwap({
            sink,
            conn: conn('new'),
            oldConn: conn('old'),
            udpPort: 40001,
            busFanout: { detach } as never,
            edgeWaitMs: 350,
        });
        expect(ok).toBe(false);
        expect(busReinput).not.toHaveBeenCalled();
        expect(detach).toHaveBeenCalledTimes(1);
    });
});

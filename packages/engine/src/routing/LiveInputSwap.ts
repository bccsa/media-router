import { createLogger } from '@media-router/shared-types';
import { busEdgeSocketPath } from '../plugins/busHelpers.js';
import { probeUnixSocket } from '../child-process/busSocketGate.js';
import type { Connection } from './MediaRouter.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { BusFanoutCoordinator } from './BusFanoutCoordinator.js';

const log = createLogger('LiveInputSwap');

/**
 * How long a removed single-input edge waits for its replacement before the
 * classic teardown (fanout detach + sink stop/start) runs. 15 s covers a
 * leisurely manual re-wire in the UI (user decision 2026-07-23); the accepted
 * cost is that a module whose input was genuinely disconnected keeps
 * streaming the OLD source for up to this long before idling — surfaced as a
 * health warning by the executor while the window is open.
 */
export const SWAP_WINDOW_MS = 15_000;

/** How long the swap path waits for the NEW producer edge socket. */
const EDGE_SOCKET_WAIT_MS = 5_000;

export interface PendingSwap {
    conn: Connection;
}

interface PendingRecord {
    entry: PendingSwap;
    timer: ReturnType<typeof setTimeout>;
    consumed: boolean;
    finalize: (entry: PendingSwap) => Promise<void>;
}

/**
 * Deferred-teardown window for live input swaps (make-before-break): a
 * removed edge on a swap-capable single-input sink is NOT torn down
 * immediately — the old producer edge stays attached so the sink never sees
 * a dead socket. A matching add on the same sink:port within the window
 * `claim()`s the entry and re-points the input live; expiry runs the classic
 * teardown via `finalize`.
 */
export class PendingInputSwaps {
    private pending = new Map<string, PendingRecord>();

    static key(conn: Connection): string {
        return `${conn.sinkModuleId}:${conn.sinkPortId}`;
    }

    /** Number of open windows (for tests / diagnostics). */
    get size(): number {
        return this.pending.size;
    }

    defer(
        entry: PendingSwap,
        finalize: (entry: PendingSwap) => Promise<void>,
        windowMs = SWAP_WINDOW_MS,
    ): void {
        const key = PendingInputSwaps.key(entry.conn);
        // A second remove on the same sink:port while one is pending — the
        // sink can only hold one old edge, so finalize the first immediately.
        const existing = this.pending.get(key);
        if (existing && !existing.consumed) {
            existing.consumed = true;
            clearTimeout(existing.timer);
            void existing.finalize(existing.entry).catch((err) =>
                log.warn({ err, key }, 'Superseded pending-swap finalize failed'),
            );
        }
        const rec: PendingRecord = {
            entry,
            consumed: false,
            finalize,
            timer: setTimeout(() => {
                if (rec.consumed) return;
                rec.consumed = true;
                this.pending.delete(key);
                log.info({ key }, 'Input-swap window expired — running classic teardown');
                void finalize(entry).catch((err) =>
                    log.warn({ err, key }, 'Pending-swap finalize failed'),
                );
            }, windowMs),
        };
        this.pending.set(key, rec);
    }

    /** Claim the pending entry for this sink:port (cancels its timer). */
    claim(conn: Connection): PendingSwap | null {
        const key = PendingInputSwaps.key(conn);
        const rec = this.pending.get(key);
        if (!rec || rec.consumed) return null;
        rec.consumed = true;
        clearTimeout(rec.timer);
        this.pending.delete(key);
        return rec.entry;
    }
}

/**
 * The live-swap procedure (the ADD half, after `PendingInputSwaps.claim`).
 * The NEW producer edge must already be attached by the caller. Ordering is
 * make-before-break: wait for the new edge socket, refresh the sink's stored
 * pipeline description (crash-replays must gate on the NEW socket), then the
 * tracked `bus_reinput` RPC — only after it confirms is the OLD edge
 * detached. Returns true on success; on ANY failure detaches the old edge
 * and returns false so the caller falls back to the classic restart.
 */
export async function performLiveSwap(opts: {
    sink: ModuleInstance;
    conn: Connection;
    oldConn: Connection;
    udpPort: number;
    busFanout?: BusFanoutCoordinator;
    /** Override for tests — how long to wait for the new edge socket. */
    edgeWaitMs?: number;
}): Promise<boolean> {
    const { sink, conn, oldConn, udpPort, busFanout } = opts;
    const swap = sink.getLiveInputSwap?.(conn.sinkPortId);
    const child = sink.getChildProcess?.();
    if (!swap || !child || !sink.running) {
        busFanout?.detach(oldConn);
        return false;
    }
    try {
        const edge = busEdgeSocketPath(udpPort, conn.id);
        const deadline = Date.now() + (opts.edgeWaitMs ?? EDGE_SOCKET_WAIT_MS);
        while (!(await probeUnixSocket(edge))) {
            if (Date.now() > deadline) {
                throw new Error(`new edge socket never appeared: ${edge}`);
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        await sink.refreshPipelineDescription?.();
        await child.busReinput(swap.element, edge);
        busFanout?.detach(oldConn);
        // Clear the pending-window warning set at teardown-defer time.
        sink.setHealth?.('ok');
        log.info(
            { sink: conn.sinkModuleId, port: conn.sinkPortId, edge },
            'Live input swap complete — downstream untouched',
        );
        return true;
    } catch (err) {
        log.warn(
            { err, sink: conn.sinkModuleId, port: conn.sinkPortId },
            'Live input swap failed — falling back to module restart',
        );
        busFanout?.detach(oldConn);
        return false;
    }
}

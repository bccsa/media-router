import { TREE_EVENTS, type TreeOp } from '@media-router/shared-types';
import type { TreeSocket } from './types.js';

/**
 * One socket's pending deltas: one frame per flush tick, and while the
 * transport is busy only the newest op per path is held (latest-wins, the
 * #677 fix generalised) and the flush retries next tick. A superseded op's
 * write id carries over so an echo is never lost.
 *
 * No wait on engine.io's `drain`: it fires when engine.io flushes its own
 * buffer, which stays empty when every frame goes through here — a waiter
 * would never wake.
 */
export class SocketOutbox {
    private queue = new Map<string, TreeOp>();
    private appendSeq = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private closed = false;

    constructor(
        private readonly socket: TreeSocket,
        private readonly flushMs: number,
    ) {}

    push(op: TreeOp): void {
        if (this.closed) return;
        // Appends ('-') are distinct entries; everything else is latest-wins.
        const key = op.path.endsWith('/-') ? `${op.path}#${++this.appendSeq}` : op.path;
        const prev = this.queue.get(key);
        if (prev) {
            this.queue.delete(key);
            if (prev.w !== undefined) op = { ...op, w: Math.max(prev.w, op.w ?? -1) };
        }
        this.queue.set(key, op);
        this.schedule();
    }

    /** Send everything queued now, busy transport or not (engine.io buffers it in order). */
    flushNow(): void {
        this.clearTimer();
        this.send();
    }

    close(): void {
        this.closed = true;
        this.clearTimer();
        this.queue.clear();
    }

    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.flushMs);
    }

    private flush(): void {
        if (this.queue.size === 0 || this.closed) return;
        if (!this.socket.conn.transport.writable) this.schedule();
        else this.send();
    }

    private send(): void {
        if (this.queue.size === 0) return;
        const ops = [...this.queue.values()];
        this.queue.clear();
        this.socket.emit(TREE_EVENTS.frame, { ops });
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}

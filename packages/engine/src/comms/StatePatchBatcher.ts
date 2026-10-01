import type { PatchOp } from '@media-router/shared-types';

/**
 * Leaf state ops on their way to the manager (`statePatch`, ADR-0025):
 * latest-wins per path inside one flush window, one numbered message per
 * window. The manager asks for a full resync when it sees a gap in `seq`.
 */
export class StatePatchBatcher {
    private pending = new Map<string, PatchOp>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;

    constructor(
        private readonly send: (message: { seq: number; ops: PatchOp[] }) => void,
        private readonly flushMs = 250,
    ) {}

    push(ops: PatchOp[]): void {
        for (const op of ops) {
            this.pending.delete(op.path);
            this.pending.set(op.path, op);
        }
        if (this.pending.size > 0 && !this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
    }

    /** Drop queued ops (a full snapshot supersedes them) and restart numbering. */
    reset(): void {
        this.pending.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.seq = 0;
    }

    private flush(): void {
        this.timer = null;
        if (this.pending.size === 0) return;
        const ops = [...this.pending.values()];
        this.pending.clear();
        this.send({ seq: ++this.seq, ops });
    }
}

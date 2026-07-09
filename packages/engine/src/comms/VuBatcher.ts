/**
 * Batches and dedups per-module VU data on its way to the manager.
 *
 * Per-module VU messages put one packet per module on the WAN dgram flow
 * (~33 pkt/s on a large engine); on a saturated uplink the flow's per-flow
 * queue (fq_codel) then delays EVERYTHING in it — including command ACKs — by
 * tens of seconds (measured on the NO-BR gate: ACKs arrived after the
 * sender's 12.6s give-up). Batching every module's latest VU into ONE wire
 * message per flush window keeps metering just as live and the flow sparse
 * enough that its queue stays empty.
 *
 * Dedup: unchanged VU inside the heartbeat window is skipped entirely; an
 * unchanged module still re-sends once per heartbeat so meters never freeze
 * stale. Batches go best-effort — VU repeats continuously, so repetition is
 * the delivery guarantee.
 */
export class VuBatcher {
    private lastVu = new Map<string, number[]>();
    private lastQueuedAt = new Map<string, number>();
    private pending: Record<string, number[]> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly sendBatch: (batch: Record<string, number[]>) => void,
        /** 100ms → 10Hz metering: fluid needles at one packet per window. */
        private readonly flushMs = 100,
        private readonly heartbeatMs = 1000,
    ) {}

    /**
     * Queue one module's VU reading. Returns false (and queues nothing) when
     * the reading is identical to the last queued one and the heartbeat
     * hasn't elapsed — the caller can reuse the verdict for its own fan-out.
     */
    enqueue(instanceId: string, data: number[]): boolean {
        const now = Date.now();
        const prev = this.lastVu.get(instanceId);
        const queuedAt = this.lastQueuedAt.get(instanceId) ?? 0;
        if (!vuChanged(prev, data) && now - queuedAt < this.heartbeatMs) return false;
        this.lastVu.set(instanceId, data);
        this.lastQueuedAt.set(instanceId, now);
        if (!this.pending) this.pending = {};
        this.pending[instanceId] = data;
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
        return true;
    }

    /** Forget a deleted module. */
    drop(instanceId: string): void {
        this.lastVu.delete(instanceId);
        this.lastQueuedAt.delete(instanceId);
        if (this.pending) delete this.pending[instanceId];
    }

    /** Drop the in-flight batch + dedup cache (disconnect): a fresh manager
     *  session has no prior VU for the dedup to be relative to. */
    reset(): void {
        this.lastVu.clear();
        this.lastQueuedAt.clear();
        this.pending = null;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    private flush(): void {
        this.flushTimer = null;
        if (!this.pending) return;
        const batch = this.pending;
        this.pending = null;
        this.sendBatch(batch);
    }
}

function vuChanged(prev: number[] | undefined, next: number[]): boolean {
    if (!prev || prev.length !== next.length) return true;
    for (let i = 0; i < next.length; i++) {
        if (prev[i] !== next[i]) return true;
    }
    return false;
}

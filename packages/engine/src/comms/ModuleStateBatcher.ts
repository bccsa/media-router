import type { ModuleRuntimeState } from '@media-router/shared-types';

/**
 * Batches and dedups module runtime state on its way to the manager.
 *
 * Every stats tick (setStatusData, ~2s per module) re-emits the module's FULL
 * runtime state; on a 50-module engine that's a continuous ~25 msg/s to the
 * manager, which rebroadcasts every one to every watching browser. Batching
 * coalesces all changes inside one flush window into a single message; dedup
 * drops modules whose state is byte-identical to the last send. vuData is
 * stripped from the manager copy — it streams on its own 'vu' channel and the
 * browser ignores it inside state payloads, but its constant churn would
 * defeat the dedup.
 *
 * Batches go best-effort; a dropped one is healed by the guaranteed periodic
 * snapshot resync (see `snapshot`). The LCP is NOT routed through this class —
 * it broadcasts the unbatched full state, vuData included.
 */
export class ModuleStateBatcher {
    private lastSent = new Map<string, string>();
    private pending: Record<string, ModuleRuntimeState> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly sendBatch: (batch: Record<string, ModuleRuntimeState>) => void,
        private readonly flushMs = 250,
    ) {}

    /** Queue one state change; no-op when byte-identical to the last send. */
    enqueue(instanceId: string, state: ModuleRuntimeState): void {
        const lean = stripVu(state);
        const key = JSON.stringify(lean);
        if (this.lastSent.get(instanceId) === key) return;
        this.lastSent.set(instanceId, key);
        if (!this.pending) this.pending = {};
        this.pending[instanceId] = lean;
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
    }

    /**
     * Prepare a full-state snapshot for a guaranteed send (connect + resync):
     * strips vuData like the incremental path, refreshes the dedup cache, and
     * supersedes any pending batch — the snapshot already contains everything
     * queued. Returns null when there are no modules.
     */
    snapshot(
        states: Record<string, ModuleRuntimeState>,
    ): Record<string, ModuleRuntimeState> | null {
        const ids = Object.keys(states);
        if (ids.length === 0) return null;
        const lean: Record<string, ModuleRuntimeState> = {};
        for (const id of ids) {
            lean[id] = stripVu(states[id]);
            this.lastSent.set(id, JSON.stringify(lean[id]));
        }
        this.clearPending();
        return lean;
    }

    /** Forget a deleted module. */
    drop(instanceId: string): void {
        this.lastSent.delete(instanceId);
        if (this.pending) delete this.pending[instanceId];
    }

    /** Drop the in-flight batch + dedup cache (disconnect): the reconnect
     *  snapshot resends everything, and a fresh manager session has no prior
     *  state for the dedup to be relative to. */
    reset(): void {
        this.clearPending();
        this.lastSent.clear();
    }

    private flush(): void {
        this.flushTimer = null;
        if (!this.pending) return;
        const batch = this.pending;
        this.pending = null;
        this.sendBatch(batch);
    }

    private clearPending(): void {
        this.pending = null;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }
}

function stripVu(state: ModuleRuntimeState): ModuleRuntimeState {
    const { vuData: _vu, ...rest } = state;
    return rest;
}

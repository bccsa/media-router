interface Pending {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * In-flight request bookkeeping for a `RunnerChannel`: id → promise, with a
 * per-request timeout. Shared by the two carriers (`ControlIpc` over a forked
 * shim, `InProcessRunnerHost` over a hosted runner) so the correlation rules
 * — one resolution per id, unknown ids ignored, everything rejected when the
 * far side goes away — live in one place.
 */
export class PendingRequests {
    private readonly pending = new Map<string, Pending>();

    constructor(private readonly label: string) {}

    get size(): number {
        return this.pending.size;
    }

    /** Register `id`; the returned promise settles on `resolve`/`reject`/timeout. */
    open(id: string, action: string, timeoutMs: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${this.label} request timeout: ${action} (${timeoutMs}ms)`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    /** Resolve `id` with the response payload. No-op for an unknown id. */
    resolve(id: string, data: unknown): void {
        const entry = this.take(id);
        entry?.resolve(data);
    }

    /** Reject `id` (the request could not be sent). No-op for an unknown id. */
    reject(id: string, err: Error): void {
        const entry = this.take(id);
        entry?.reject(err);
    }

    /** Reject everything in flight — the far side is gone. */
    rejectAll(err: Error): void {
        for (const id of [...this.pending.keys()]) this.reject(id, err);
    }

    private take(id: string): Pending | undefined {
        const entry = this.pending.get(id);
        if (!entry) return undefined;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        return entry;
    }
}

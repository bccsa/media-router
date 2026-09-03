import type { ControlIpcMessage } from '@media-router/shared-types';

interface PendingRequest {
    requestId: string;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * The runner's outbound side of the control channel: events and responses go
 * to whoever hosts the `GstRunner` through one `post` function. In-process
 * (the default) that is `InProcessRunnerHost.receive`; under the legacy fork
 * it is `process.send` (see `gst-runner.ts`, which also absorbs the closed-
 * channel window during shutdown so late Python events can't throw).
 *
 * Also owns the in-flight request map for round-trip Python commands
 * (`get_property`, `get_stats`, `get_throughput`). Each tracked request has a
 * 5s timeout so a misbehaving Python child can't leak pending entries.
 */
export class ParentIpc {
    private readonly pending = new Map<string, PendingRequest>();

    constructor(private readonly post: (msg: ControlIpcMessage) => void) {}

    /** Fire-and-forget event to the parent (no request id). */
    sendEvent(action: string, data?: unknown): void {
        this.send({ id: '', type: 'event', action, data });
    }

    /** Reply to a parent request by id. */
    sendResponse(requestId: string, data?: unknown): void {
        this.send({ id: requestId, type: 'response', action: '', data });
    }

    /**
     * Register a pending Python-side request. When the event matching `reqId`
     * comes back, call `resolvePending(reqId, payload)`. If 5s elapse first,
     * the parent gets an error response and the entry is dropped.
     */
    trackPending(reqId: string, parentReqId: string, label: string): void {
        this.pending.set(reqId, {
            requestId: parentReqId,
            timer: setTimeout(() => {
                this.pending.delete(reqId);
                this.sendResponse(parentReqId, { error: `Timeout waiting for ${label}` });
            }, 5000),
        });
    }

    /**
     * Resolve a tracked Python response. No-op if the id is unknown (timeout
     * already fired, or the event was a one-way notification).
     */
    resolvePending(reqId: string, payload: unknown): void {
        const entry = this.pending.get(reqId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(reqId);
        this.sendResponse(entry.requestId, payload);
    }

    /** Drop every in-flight request (host gone — nothing to answer to). */
    clearPending(): void {
        for (const entry of this.pending.values()) clearTimeout(entry.timer);
        this.pending.clear();
    }

    private send(msg: ControlIpcMessage): void {
        try {
            this.post(msg);
        } catch {
            /* host gone mid-write */
        }
    }
}

import type { Connection, ActiveHandle } from './MediaRouter.js';

/**
 * Pluggable per-stream-type executor used by `ConnectionExecutor`. Each
 * implementation owns:
 *   - building the `ActiveHandle` for a new connection of its stream type
 *   - tearing down a previously-built handle (dispatched by `handle.type`)
 *
 * The engine pre-registers the two built-in executors (PCM audio, MPEG-TS
 * over UDP) during `Engine.start()`. Plugins can register more via
 * `services.streamExecutors.register(...)` from their static
 * `registerServices` hook — this is the same dispatcher used at runtime,
 * so a registered executor is immediately picked up.
 *
 * `streamType` is read on the way *in* (`execute`); `handleType` is read on
 * the way *out* (`teardown`). They're kept separate so the same stream type
 * could in principle emit different handle shapes per connection.
 */
export interface StreamTypeExecutor {
    /** Stream type this executor handles (e.g. `"audio/pcm"`, `"muxed/mpegts"`). */
    readonly streamType: string;
    /** Handle type produced by `execute` — used for teardown dispatch. */
    readonly handleType: ActiveHandle['type'];
    /** Build an active handle for a new connection, or `null` if it can't be created. */
    execute(conn: Connection): Promise<ActiveHandle | null>;
    /** Tear down a previously-built handle. */
    teardown(
        handle: ActiveHandle,
        conn: Connection | undefined,
        skipModuleRestart: boolean,
    ): Promise<void>;
}

/**
 * Registry of `StreamTypeExecutor` keyed by both `streamType` (for `execute`
 * dispatch) and `handleType` (for `teardown` dispatch).
 */
export class StreamTypeExecutorRegistry {
    private readonly byStreamType = new Map<string, StreamTypeExecutor>();
    private readonly byHandleType = new Map<string, StreamTypeExecutor>();

    /**
     * Register an executor for its own `streamType` (+ optional aliases).
     *
     * `extraStreamTypes` maps additional stream types onto the SAME instance —
     * used for `audio/302m`, which rides the MPEG-TS transport unchanged.
     * Never register a second instance of the same executor class for an
     * alias instead: teardown dispatches by `handleType` (one slot), so
     * execute/teardown would split across instances and any per-instance
     * state (e.g. MpegTsBusExecutor's materialize-attempt tracking) would
     * desync.
     */
    register(executor: StreamTypeExecutor, extraStreamTypes: string[] = []): void {
        this.byStreamType.set(executor.streamType, executor);
        for (const st of extraStreamTypes) this.byStreamType.set(st, executor);
        this.byHandleType.set(executor.handleType, executor);
    }

    /** Find the executor responsible for a given stream type (`execute` path). */
    forStreamType(streamType: string): StreamTypeExecutor | undefined {
        return this.byStreamType.get(streamType);
    }

    /** Find the executor responsible for a given handle (`teardown` path). */
    forHandle(handle: ActiveHandle): StreamTypeExecutor | undefined {
        return this.byHandleType.get(handle.type);
    }

    /** All registered stream types — useful for debug/diagnostics. */
    streamTypes(): string[] {
        return Array.from(this.byStreamType.keys());
    }
}

/** Short label for logging: `[src → sink]`, with display-name resolution when available. */
export function makeConnLabel(
    displayNameResolver?: (id: string) => string,
): (conn: Connection) => string {
    return (conn) => {
        const src = displayNameResolver?.(conn.sourceModuleId) ?? conn.sourceModuleId;
        const dst = displayNameResolver?.(conn.sinkModuleId) ?? conn.sinkModuleId;
        return `[${src} → ${dst}]`;
    };
}

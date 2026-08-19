import { createLogger, applyJsonPatch, LiveArrayIndex } from '@media-router/shared-types';
import type { PatchOp, ChannelMapEntry } from '@media-router/shared-types';

/** PatchOp with resolved connection ID for side effect handling. */
interface ResolvedPatchOp extends PatchOp {
    _connId?: string;
}
import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { LcpServer } from './comms/LcpServer.js';
import type { ManagerConnection } from './comms/ManagerConnection.js';
import type { ModuleLifecycle } from './modules/ModuleLifecycle.js';

const log = createLogger('EnginePatchRouter');

/**
 * Engine-side N-1 Patch Router.
 *
 * Receives JSON Patch ops from any client (manager or LCP),
 * applies to currentConfig, detects and executes side effects,
 * and forwards to all other clients (skip sender).
 *
 * Manager sends patch → apply + side effects → send to all LCPs
 * LCP sends patch     → apply + side effects → send to manager + all other LCPs
 */
export class EnginePatchRouter {
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Mutex for lifecycle operations (add/remove/enable/disable). */
    private lifecycleLock: Promise<void> = Promise.resolve();

    constructor(
        private moduleManager: ModuleManager,
        private mediaRouter: MediaRouter,
        private lcpServer: LcpServer,
        private managerConnection: ManagerConnection,
        private lifecycle: ModuleLifecycle,
        private getConfig: () => Record<string, unknown> | null,
        private getModulesRunning: () => boolean,
    ) {}

    /**
     * Process a patch from any source.
     * @param senderId  Socket ID of the sender (LCP socket ID or 'manager')
     * @param senderType  'manager' or 'lcp'
     * @param ops  JSON Patch operations
     */
    onPatch(senderId: string, senderType: 'manager' | 'lcp', ops: PatchOp[]): void {
        if (!ops || ops.length === 0) return;

        const config = this.getConfig();
        if (!config) {
            log.warn('No config — dropping patch');
            return;
        }

        log.debug({ senderType, opCount: ops.length }, 'Processing patch');

        // 1. Pre-resolve connection IDs from index-based paths (before applying removes them)
        const resolvedOps = this.resolveConnectionIds(ops, config);

        // 2. Apply to in-memory config
        applyJsonPatch(config, ops);

        // 3. Detect side effects and execute
        this.detectSideEffects(resolvedOps, config);

        // 3. Forward to other clients (skip sender)
        if (senderType === 'manager') {
            // From manager → broadcast to ALL LCPs
            this.lcpServer.broadcastConfigUpdate(ops);
        } else {
            // From LCP → broadcast to other LCPs (skip sender) + debounced forward to manager
            this.lcpServer.broadcastConfigUpdateExcept(senderId, ops);
            this.debouncedForwardToManager(ops);
        }
    }

    /**
     * Detect side effects from patch ops and execute them.
     */
    private detectSideEffects(ops: ResolvedPatchOp[], config: Record<string, unknown>): void {
        // Collect settings changes per module for batched live updates
        const settingsChanges = new Map<string, Record<string, unknown>>();

        for (const op of ops) {
            const parts = op.path.split('/').filter(Boolean);

            // Module settings change → collect for batched live update
            if (
                parts[0] === 'modules' &&
                parts[2] === 'settings' &&
                parts[3] &&
                (op.op === 'replace' || op.op === 'add')
            ) {
                const moduleId = parts[1];
                const key = parts[3];
                if (!settingsChanges.has(moduleId)) settingsChanges.set(moduleId, {});
                settingsChanges.get(moduleId)![key] = op.value;
            }

            // Module enabled/disabled → lifecycle operation
            if (parts[0] === 'modules' && parts[2] === 'enabled' && op.op === 'replace') {
                const moduleId = parts[1];
                this.lifecycleLock = this.lifecycleLock
                    .then(() =>
                        op.value
                            ? this.lifecycle.enable(moduleId)
                            : this.lifecycle.disable(moduleId),
                    )
                    .catch((err) => log.error({ err, moduleId }, 'Enable/disable failed'));
            }

            // Module added → start it (only when the engine is in the running
            // state — otherwise the user explicitly stopped, and adding/cloning
            // a module shouldn't silently bring it up).
            if (op.op === 'add' && parts[0] === 'modules' && parts.length === 2) {
                const moduleId = parts[1];
                if (this.getModulesRunning()) {
                    this.lifecycleLock = this.lifecycleLock
                        .then(() => this.lifecycle.startSingle(moduleId))
                        .catch((err) => log.error({ err, moduleId }, 'Module start failed'));
                } else {
                    log.info(
                        { moduleId },
                        'Module added while engine stopped — skipping auto-start',
                    );
                }
            }

            // Module removed → delete it
            if (op.op === 'remove' && parts[0] === 'modules' && parts.length === 2) {
                const moduleId = parts[1];
                this.lifecycleLock = this.lifecycleLock
                    .then(() => this.lifecycle.deleteSingle(moduleId))
                    .catch((err) => log.error({ err, moduleId }, 'Module delete failed'));
            }

            // Connection added → create routing (chained to lifecycle lock so module exists first)
            if (op.op === 'add' && parts[0] === 'connections' && parts.length <= 2) {
                const conn = op.value as Record<string, unknown>;
                if (conn?.sourceModuleId) {
                    this.lifecycleLock = this.lifecycleLock
                        .then(() =>
                            this.mediaRouter.createConnection(
                                conn.sourceModuleId as string,
                                conn.sourcePortId as string,
                                conn.sinkModuleId as string,
                                conn.sinkPortId as string,
                                conn.channelMap as ChannelMapEntry[] | undefined,
                            ),
                        )
                        .then((connId) => {
                            log.info({ connectionId: connId }, 'Live connect');
                        })
                        .catch((err) => log.error({ err }, 'Live connect failed'));
                }
            }

            // Connection removed → destroy routing (chained to lifecycle lock)
            if (op.op === 'remove' && parts[0] === 'connections' && parts.length === 2) {
                const connectionId = op._connId as string | undefined;
                if (connectionId) {
                    this.lifecycleLock = this.lifecycleLock
                        .then(async () => {
                            await this.mediaRouter.removeConnection(connectionId);
                        })
                        .catch((err) => log.error({ err, connectionId }, 'Live disconnect failed'));
                }
            }

            // Channel map updated → update routing (chained to lifecycle lock)
            if (
                parts[0] === 'connections' &&
                parts[2] === 'channelMap' &&
                (op.op === 'replace' || op.op === 'add')
            ) {
                let connectionId = op._connId as string | undefined;
                if (!connectionId) {
                    const idx = parseInt(parts[1], 10);
                    const conns = (config.connections ?? []) as Array<Record<string, unknown>>;
                    connectionId = (!isNaN(idx) ? conns[idx]?.id : undefined) as string | undefined;
                }
                if (connectionId) {
                    const resolvedId = connectionId;
                    log.info(
                        { connectionId: resolvedId, hasMap: op.value != null },
                        'Channel map update',
                    );
                    this.lifecycleLock = this.lifecycleLock
                        .then(() =>
                            this.mediaRouter.updateChannelMap(
                                resolvedId,
                                op.value as ChannelMapEntry[] | undefined,
                            ),
                        )
                        .catch((err) =>
                            log.error(
                                { err, connectionId: resolvedId },
                                'Channel map update failed',
                            ),
                        );
                } else {
                    log.warn(
                        { path: op.path },
                        'Channel map update — could not resolve connection ID',
                    );
                }
            }
        }

        // Apply batched settings changes (live config updates)
        for (const [moduleId, changes] of settingsChanges) {
            this.moduleManager
                .applyConfigUpdate(moduleId, changes)
                .catch((err) => log.warn({ err, moduleId }, 'Live config update failed'));
        }
    }

    /**
     * Pre-resolve connection IDs from index-based paths before applying the patch.
     * After applyJsonPatch removes a connection, we can't look it up anymore.
     * Attaches _connId to ops that reference connections by index.
     *
     * An index is only valid at the instant its own op applies. The manager
     * emits progressively-valid indices for a batch — two removes of adjacent
     * connections arrive as `[remove /connections/1, remove /connections/1]`,
     * because the first removal shifts the array. Resolving the whole batch
     * against the pre-patch array named the same connection twice: the live
     * routing for the second one was never torn down (config ended correct,
     * the pipeline leaked a running connection).
     *
     * So fold each op's structural effect into a working view as we map —
     * `LiveArrayIndex`, the same fold the manager runs on the sending side of
     * this boundary (shared-types, next to the `applyJsonPatch` semantics it
     * mirrors: numeric index else `.id` match, `add` at an index assigns rather
     * than inserts, `-` appends and never matches for remove). Element
     * *contents* stay pre-patch; only membership and order move, which is
     * exactly what the id lookup needs.
     */
    private resolveConnectionIds(
        ops: PatchOp[],
        config: Record<string, unknown>,
    ): ResolvedPatchOp[] {
        const connections = new LiveArrayIndex<Record<string, unknown>>(
            '/connections',
            (config.connections ?? []) as Array<Record<string, unknown>>,
        );

        return ops.map((op) => {
            const parts = op.path.split('/').filter(Boolean);
            if (parts[0] !== 'connections') return op;

            // Read the id BEFORE folding this op in — a remove is exactly the
            // case where the element is gone afterwards. A whole-array write
            // (`/connections`) addresses no element, so there is nothing to
            // read; `track` still resets the membership below.
            const connId =
                parts.length > 1
                    ? (connections.at(parts[1])?.id as string | undefined)
                    : undefined;
            connections.track(op);

            return connId ? ({ ...op, _connId: connId } as ResolvedPatchOp) : op;
        });
    }

    /**
     * Debounced forward of LCP patches to manager (100ms).
     * Accumulates ops so rapid changes (e.g. fader movement) don't lose intermediate values.
     */
    private pendingOps: PatchOp[] = [];

    private debouncedForwardToManager(ops: PatchOp[]): void {
        this.pendingOps.push(...ops);
        const key = 'lcpPatch';
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(
            key,
            setTimeout(() => {
                this.debounceTimers.delete(key);
                if (this.managerConnection.isConnected && this.pendingOps.length > 0) {
                    this.managerConnection.send('patch', { ops: this.pendingOps });
                }
                this.pendingOps = [];
            }, 100),
        );
    }

    /** Clean up timers. */
    destroy(): void {
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }
}

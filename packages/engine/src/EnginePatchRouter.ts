import { createLogger, applyJsonPatch, LiveArrayIndex } from '@media-router/shared-types';
import type { PatchOp, ChannelMapEntry } from '@media-router/shared-types';

/** PatchOp with resolved connection ID for side effect handling. */
interface ResolvedPatchOp extends PatchOp {
    _connId?: string;
}
import type { ModuleManager } from './modules/ModuleManager.js';
import type { MediaRouter } from './routing/MediaRouter.js';
import type { LocalServer } from './comms/LocalServer.js';
import type { LocalChanges } from './comms/LocalChanges.js';
import type { ModuleLifecycle } from './modules/ModuleLifecycle.js';

const log = createLogger('EnginePatchRouter');

/**
 * Engine-side N-1 Patch Router.
 *
 * Receives JSON Patch ops from the manager or from this router's own tree
 * (a dashboard on site), applies them to currentConfig, runs their side
 * effects and passes them on, skipping the sender.
 *
 * Manager sends patch → apply + side effects → router tree
 * Local write         → apply + side effects → manager + the rest of the router tree
 */
export class EnginePatchRouter {
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Mutex for lifecycle operations (add/remove/enable/disable). */
    private lifecycleLock: Promise<void> = Promise.resolve();

    constructor(
        private moduleManager: ModuleManager,
        private mediaRouter: MediaRouter,
        private localServer: LocalServer,
        private localChanges: Pick<LocalChanges, 'config'>,
        private lifecycle: ModuleLifecycle,
        private getConfig: () => Record<string, unknown> | null,
        private getModulesRunning: () => boolean,
    ) {}

    /**
     * Process a patch from any source.
     * @param senderId  Socket ID of the sender (a router tree socket, or 'manager')
     * @param senderType  'manager' or 'local'
     * @param ops  JSON Patch operations
     */
    onPatch(senderId: string, senderType: 'manager' | 'local', ops: PatchOp[]): void {
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

        // 4. Forward to the other clients, skipping the sender.
        if (senderType === 'manager') {
            this.localServer.configChanged(ops);
        } else {
            // A local write: the rest of the router tree, and the manager (throttled).
            this.localServer.configChanged(ops, senderId);
            this.forwardToManager(ops);
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

        // Apply batched settings changes (live config updates), then re-resolve
        // the module's dynamic ports: an operator edit that changes the port
        // set (a muxer input removed) must retire the vanished port — and the
        // connection on it — now, not at the restart the edit is pending on;
        // until then the edge would dangle in the UI. `refreshPorts` diffs and
        // no-ops when the set is unchanged or the module is not running (a
        // stopped module re-resolves at start).
        for (const [moduleId, changes] of settingsChanges) {
            this.moduleManager
                .applyConfigUpdate(moduleId, changes)
                .then(() => this.lifecycle.refreshPorts(moduleId))
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
     * Forward of local patches to the manager, at most one send per 100 ms
     * (ops batched meanwhile), so a fader drag reaches it while moving.
     * Guaranteed when linked, journaled during an outage (LocalChanges, ADR-0025).
     */
    private pendingOps: PatchOp[] = [];
    private lastForward = 0;

    private forwardToManager(ops: PatchOp[]): void {
        this.pendingOps.push(...ops);
        const key = 'localPatch';
        if (this.debounceTimers.has(key)) return;
        const flush = () => {
            this.debounceTimers.delete(key);
            this.lastForward = Date.now();
            const batch = this.pendingOps;
            this.pendingOps = [];
            this.localChanges.config(batch);
        };
        const wait = this.lastForward + 100 - Date.now();
        if (wait <= 0) flush();
        else this.debounceTimers.set(key, setTimeout(flush, wait));
    }

    /** Clean up timers. */
    destroy(): void {
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }
}

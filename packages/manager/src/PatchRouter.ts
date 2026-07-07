import type { Server as SocketIOServer } from 'socket.io';
import { createLogger, applyJsonPatch } from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';
import type { ConfigStore } from './config/ConfigStore.js';
import type { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import type { EngineEventForwarder } from './handlers/EngineEventForwarder.js';
import type { PluginRegistry } from './plugins/PluginRegistry.js';
import { dispatchRule, type RuleContext } from './patchRules.js';

const log = createLogger('PatchRouter');

/**
 * Canonical sender id for an engine. Used across transports so the patch
 * router can reason about "who sent this" with a single string regardless of
 * whether it came over Socket.IO (browser) or dgram-comms (engine).
 *
 * Browsers use their Socket.IO `socket.id` — already globally unique. Engines
 * use `engine:<engineId>`, which can never collide with a Socket.IO id (those
 * are random base-whatever strings, not prefixed with `engine:`).
 */
export function engineSenderId(engineId: string): string {
    return `engine:${engineId}`;
}

/**
 * Manager-side N-1 Patch Router.
 *
 * Receives JSON Patch ops from any client (browser or engine), persists to
 * SQLite, detects side effects, and forwards to every destination except the
 * sender. Both transports (Socket.IO browsers, dgram engine) follow one
 * invariant — the sender gets only the cascades preprocessing added, every
 * other destination gets the full processed op list.
 */
export class PatchRouter {
    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private io: SocketIOServer,
        private pluginRegistry: PluginRegistry,
        private eventForwarder: EngineEventForwarder,
    ) {}

    /**
     * Process a patch from any source (browser or engine).
     *
     * Sender IDs are unified strings across transports:
     *   - Browser senders use their Socket.IO `socket.id` (e.g. "AbC123").
     *   - Engine senders use the sentinel `engineSenderId(engineId)` (e.g.
     *     "engine:local"). This lets the broadcast logic treat "sender" as
     *     a single string regardless of transport, with one rule for all
     *     destinations.
     *
     * @param senderId  Unified sender ID (browser socket.id or engine sentinel).
     * @param engineId  Which engine's config to patch.
     * @param ops       JSON Patch operations as sent by the originator.
     */
    onPatch(senderId: string, engineId: string, ops: PatchOp[]): void {
        if (!ops || ops.length === 0) return;

        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId }, 'No active profile — dropping patch');
            return;
        }

        log.debug({ engineId, senderId, opCount: ops.length }, 'Processing patch');

        // `preprocessOps` returns two op lists:
        //   - `processed`: full list applied to the stored config (rewrites of
        //     originals + cascades added by preprocessing).
        //   - `cascades`: only ops added by preprocessing on top of what the
        //     sender sent (e.g. interlock mutes, connection cleanup on module
        //     delete). The sender has NOT applied these.
        // Rewrites of originals deliberately stay out of `cascades` — echoing
        // them back to the sender would double-apply (e.g. a rewritten
        // index-based remove on an array the sender already spliced by id).
        let processed: PatchOp[] = [];
        let cascades: PatchOp[] = [];
        const updatedConfig = this.configStore.modifyProfileConfig(
            engineId,
            engine.active_profile as string,
            (config) => {
                const result = this.preprocessOps(engineId, config, ops);
                processed = result.processed;
                cascades = result.cascades;
                applyJsonPatch(config, processed);
                return config;
            },
        );

        this.broadcast(engineId, senderId, processed, cascades, ops, updatedConfig);
    }

    /**
     * N-1 dispatch — send the patch to every destination for `engineId` except
     * the sender. One invariant, uniformly applied across both transports:
     *
     *   destination IS sender   → receive `cascades` only
     *   destination NOT sender  → receive the full op list
     *
     * The payload's path form differs by transport (engine needs index-based
     * paths because `applyJsonPatch` can't walk arrays by id; browsers prefer
     * id-based because their store's applyOp handles both and id paths survive
     * concurrent array mutations). That's a transport detail — the rule above
     * stays the same.
     *
     * Socket.IO handles browser fan-out natively via rooms: `except(senderId)`
     * excludes the sender socket, `to(senderId)` targets just them. When the
     * engine is the sender, its sentinel id matches no Socket.IO socket, so
     * `except` broadcasts to all browsers and `to` is a no-op — the same rule
     * produces the correct result without branching on sender type.
     */
    private broadcast(
        engineId: string,
        senderId: string,
        processed: PatchOp[],
        cascades: PatchOp[],
        originals: PatchOp[],
        updatedConfig: Record<string, unknown> | undefined,
    ): void {
        const engineSid = engineSenderId(engineId);

        // --- Engine destination (dgram-comms, index-based paths) ---
        if (this.engineManager.isEngineOnline(engineId)) {
            const delta = senderId === engineSid ? cascades : processed;
            if (delta.length > 0) {
                this.engineManager.sendToEngine(
                    engineId,
                    'patch',
                    { ops: delta },
                    { guaranteeDelivery: true },
                );
            }
        }

        // --- Browser destinations (Socket.IO, id-based originals + cascades) ---
        // Non-sender browsers get originals (id-based, unambiguous under
        // concurrent edits) plus any cascades preprocessing added, with UI
        // fields merged onto module-adds.
        const enriched = this.enrichOpsForBroadcast(
            engineId,
            [...originals, ...cascades],
            updatedConfig,
        );
        this.io.except(senderId).emit('engine:update', { engineId, patch: enriched });
        // Sender browser (if any) already applied originals — send cascades only.
        // No-op when engineSenderId was the sender (no socket matches).
        if (cascades.length > 0) {
            this.io.to(senderId).emit('engine:update', { engineId, patch: cascades });
        }
    }

    /**
     * Dispatch each incoming op through the rule table.
     *
     * `preprocessOps` is intentionally tiny — all domain logic lives in
     * `patchRules.ts`. Adding a new cascade = adding a new rule function.
     * The dispatcher itself never needs to change.
     *
     * `RuleContext` is snapshotted once before the loop runs, so rules see
     * the pre-patch state of modules/interlocks/connections. The full
     * processed list is then applied in one `applyJsonPatch` call by the
     * caller — this matches the old behaviour (cascades fire on pre-patch
     * state, not on an intermediate state between ops).
     */
    private preprocessOps(
        engineId: string,
        config: Record<string, unknown>,
        ops: PatchOp[],
    ): { processed: PatchOp[]; cascades: PatchOp[] } {
        if (!Array.isArray(config.interlocks)) config.interlocks = [];
        const ctx: RuleContext = {
            modules: (config.modules ?? {}) as Record<string, Record<string, unknown>>,
            interlocks: config.interlocks as Array<{ id: string; members: string[] }>,
            connections: (config.connections ?? []) as Array<Record<string, unknown>>,
            pluginRegistry: this.pluginRegistry,
            engineSchemas: this.eventForwarder.getPluginSchemas(engineId),
        };

        const processed: PatchOp[] = [];
        const cascades: PatchOp[] = [];
        for (const op of ops) {
            const result = dispatchRule(op, ctx);
            processed.push(...result.processed);
            cascades.push(...result.cascades);
        }
        return { processed, cascades };
    }

    /**
     * Enrich ops for broadcast (e.g. module add needs full module data with manifest info).
     */
    private enrichOpsForBroadcast(
        engineId: string,
        ops: PatchOp[],
        updatedConfig: Record<string, unknown> | undefined,
    ): PatchOp[] {
        const enriched: PatchOp[] = [];

        for (const op of ops) {
            // Module add: stamp manifest fields + runtime defaults so freshly
            // added modules render the same as those rehydrated by `engine:list`.
            // Without this, plugin features keyed off manifest fields (resize
            // grip, interlock affordance, status sections) only appear after a
            // full refresh.
            if (op.op === 'add' && op.path.match(/^\/modules\/[^/]+$/) && op.value) {
                const moduleId = op.path.split('/')[2];
                const value: Record<string, unknown> = {
                    ...(op.value as Record<string, unknown>),
                };
                this.pluginRegistry.enrichModule(
                    moduleId,
                    value,
                    this.eventForwarder.getPluginSchemas(engineId),
                );
                enriched.push({ ...op, value });
                continue;
            }

            enriched.push(op);
        }

        return enriched;
    }
}

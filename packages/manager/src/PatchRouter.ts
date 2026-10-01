import { createLogger, applyJsonPatch, LiveArrayIndex } from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';
import type { ConfigStore } from './config/ConfigStore.js';
import type { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import type { PluginRegistry } from './plugins/PluginRegistry.js';
import type { RuntimeCache } from './tree/RuntimeCache.js';
import type { ConfigOp, TreePublisher } from './tree/TreePublisher.js';
import { dispatchRule, type RuleContext } from './patchRules.js';

/** The router announced it keeps its interlocks itself (ADR-0028); until its stats say so, the manager does. */
export function routerKeepsInterlocks(runtime: Pick<RuntimeCache, 'getData'>, engineId: string): boolean {
    const features = runtime.getData(engineId, 'features');
    return Array.isArray(features) && features.includes('interlocks');
}

const log = createLogger('PatchRouter');

/**
 * Canonical sender id for an engine. Browsers use their Socket.IO `socket.id`;
 * engines use `engine:<engineId>`, which can never collide with one.
 */
export function engineSenderId(engineId: string): string {
    return `engine:${engineId}`;
}

type Keyed = { id?: unknown };

/** `/connections/<index>…` → `/connections/<id>…` so tree subscribers address elements by id. */
function idPath(op: PatchOp, arrays: Record<string, LiveArrayIndex<Keyed>>): PatchOp {
    const m = /^\/(connections|interlocks)\/(\d+)(\/.*)?$/.exec(op.path);
    if (!m) return op;
    const id = arrays[m[1]].at(m[2])?.id;
    return typeof id === 'string' ? { ...op, path: `/${m[1]}/${id}${m[3] ?? ''}` } : op;
}

interface Processed {
    /** Full ordered list applied to the stored config (index paths, for engines). */
    processed: PatchOp[];
    /** Ops preprocessing added on top of what the sender sent. */
    cascades: PatchOp[];
    /** The same ops in id-path form, flagged by origin, for the tree. */
    published: ConfigOp[];
    /** Indexes of sender ops that the rules dropped (unknown id, …). */
    dropped: number[];
}

/**
 * Manager-side patch router: persists config ops from a browser or an engine,
 * adds cascades (patchRules.ts), and forwards them — to the engine as index
 * paths (the sender engine gets cascades only), to the tree as id paths (a
 * browser sender gets its own ops back as the write echo).
 */
export class PatchRouter {
    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private publisher: TreePublisher,
        private pluginRegistry: PluginRegistry,
        private runtime: RuntimeCache,
    ) {}

    /** Returns the indexes of `ops` that were dropped instead of applied. */
    onPatch(senderId: string, engineId: string, ops: PatchOp[], writeId?: number): number[] {
        if (!ops || ops.length === 0) return [];
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId }, 'No active profile — dropping patch');
            return ops.map((_, i) => i);
        }

        let result: Processed = { processed: [], cascades: [], published: [], dropped: [] };
        this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
            result = this.preprocessOps(engineId, config, ops);
            applyJsonPatch(config, result.processed);
            return config;
        });

        this.reconcileModuleStateCache(engineId, result.processed);
        this.sendToEngine(engineId, senderId, result);
        this.publisher.config(engineId, this.enrich(engineId, result.published), senderId, writeId);
        if (result.processed.some((op) => /^\/(modules\/[^/]+|connections(\/[^/]+)?)$/.test(op.path))) {
            this.publisher.info(engineId);
        }
        return result.dropped;
    }

    /** Removed modules lose their cached state; re-added ones lose their tombstone. */
    private reconcileModuleStateCache(engineId: string, processed: PatchOp[]): void {
        const removed: string[] = [];
        const added: string[] = [];
        for (const op of processed) {
            const match = /^\/modules\/([^/]+)$/.exec(op.path);
            if (!match) continue;
            if (op.op === 'remove') removed.push(match[1]);
            else if (op.op === 'add') added.push(match[1]);
        }
        if (added.length > 0) this.runtime.clearModuleTombstones(engineId, added);
        if (removed.length > 0) this.runtime.purgeModuleStates(engineId, removed);
    }

    /** N-1 to the engine: the engine as sender gets only the cascades it did not apply. */
    private sendToEngine(engineId: string, senderId: string, r: Processed): void {
        if (!this.engineManager.isEngineOnline(engineId)) return;
        const delta = senderId === engineSenderId(engineId) ? r.cascades : r.processed;
        if (delta.length > 0) {
            this.engineManager.sendToEngine(engineId, 'patch', { ops: delta }, { guaranteeDelivery: true });
        }
    }

    /**
     * Run each op through the rule table. Module state is snapshotted once,
     * so cascades see the pre-patch world; array membership folds forward
     * (`LiveArrayIndex`) so an index is valid at the point its op applies.
     */
    private preprocessOps(engineId: string, config: Record<string, unknown>, ops: PatchOp[]): Processed {
        if (!Array.isArray(config.interlocks)) config.interlocks = [];
        const arrays = {
            connections: new LiveArrayIndex<Keyed>('/connections', (config.connections ?? []) as Keyed[]),
            interlocks: new LiveArrayIndex<Keyed>('/interlocks', config.interlocks as Keyed[]),
        };
        const base = {
            modules: (config.modules ?? {}) as Record<string, Record<string, unknown>>,
            pluginRegistry: this.pluginRegistry,
            engineSchemas: this.runtime.getPluginSchemas(engineId),
            routerInterlocks: routerKeepsInterlocks(this.runtime, engineId),
        };
        const out: Processed = { processed: [], cascades: [], published: [], dropped: [] };
        ops.forEach((op, index) => {
            const ctx: RuleContext = {
                ...base,
                connections: arrays.connections.snapshot() as Array<Record<string, unknown>>,
                interlocks: arrays.interlocks.snapshot() as Array<{ id: string; members: string[] }>,
            };
            const result = dispatchRule(op, ctx);
            const cascades = new Set(result.cascades);
            if (!result.processed.some((p) => !cascades.has(p))) out.dropped.push(index);
            out.processed.push(...result.processed);
            out.cascades.push(...result.cascades);
            for (const emitted of result.processed) {
                out.published.push({ op: idPath(emitted, arrays), fromSender: !cascades.has(emitted) });
                arrays.connections.track(emitted);
                arrays.interlocks.track(emitted);
            }
        });
        return out;
    }

    /** Module adds carry manifest fields + runtime defaults, like a snapshot does. */
    private enrich(engineId: string, entries: ConfigOp[]): ConfigOp[] {
        return entries.map((entry) => {
            const { op } = entry;
            if (op.op !== 'add' || !/^\/modules\/[^/]+$/.test(op.path) || !op.value) return entry;
            const value = { ...(op.value as Record<string, unknown>) };
            this.pluginRegistry.enrichModule(op.path.split('/')[2], value, this.runtime.getPluginSchemas(engineId));
            return { ...entry, op: { ...op, value } };
        });
    }
}

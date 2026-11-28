import {
    createLogger,
    applyJsonPatch,
    dependentsOverMaximum,
    isEditorPath,
    joinPath,
    splitPath,
    LiveArrayIndex,
} from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';
import type { ConfigStore } from './config/ConfigStore.js';
import type { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import type { PluginRegistry } from './plugins/PluginRegistry.js';
import type { RuntimeCache } from './tree/RuntimeCache.js';
import type { ConfigOp, TreePublisher } from './tree/TreePublisher.js';
import { dispatchRule } from './patchRules.js';
import { EditorBatch } from './editorRules.js';

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

export interface Processed {
    /** Full ordered list applied to the stored config (index paths, for engines). */
    processed: PatchOp[];
    /** Ops preprocessing added on top of what the sender sent. */
    cascades: PatchOp[];
    /** The same ops in id-path form, flagged by origin, for the tree. */
    published: ConfigOp[];
    /** Indexes of sender ops that the rules dropped (unknown id, …). */
    dropped: number[];
    /** Indexes of sender editor ops that changed nothing (an add of an existing key, a remove of a missing one). */
    swallowed: number[];
    /** Why a dropped op was dropped, where there is more to say than "not applied". */
    reasons: Record<number, string>;
}

/** What became of a sender's ops, by index. A swallowed op is no failure: its writer is sent the current value. */
export type PatchOutcome = Pick<Processed, 'dropped' | 'swallowed' | 'reasons'>;

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
        return this.write(senderId, engineId, ops, writeId).dropped;
    }

    /** `onPatch`, telling dropped ops (with their reasons) from swallowed ones. */
    write(senderId: string, engineId: string, ops: PatchOp[], writeId?: number): PatchOutcome {
        if (!ops || ops.length === 0) return { dropped: [], swallowed: [], reasons: {} };
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId }, 'No active profile — dropping patch');
            return { dropped: ops.map((_, i) => i), swallowed: [], reasons: {} };
        }

        let result: Processed = { processed: [], cascades: [], published: [], dropped: [], swallowed: [], reasons: {} };
        this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
            result = this.preprocessOps(engineId, config, ops);
            // Editor values go in as copies: a seed published ahead of the batch's
            // later editor ops must not carry their effect.
            const copied = result.processed.map((op) => (isEditorPath(op.path) ? { ...op, value: structuredClone(op.value) } : op));
            applyJsonPatch(config, copied);
            const clamps = this.clampDependents(engineId, config, result.processed);
            if (clamps.length > 0) {
                applyJsonPatch(config, clamps);
                result.processed.push(...clamps);
                result.cascades.push(...clamps);
                result.published.push(...clamps.map((op) => ({ op, fromSender: false })));
            }
            return config;
        });

        this.reconcileModuleStateCache(engineId, result.processed);
        this.sendToEngine(engineId, senderId, result);
        this.publisher.config(engineId, this.enrich(engineId, result.published), senderId, writeId);
        if (result.processed.some((op) => /^\/(modules\/[^/]+|connections(\/[^/]+)?)$/.test(op.path))) {
            this.publisher.info(engineId);
        }
        const { dropped, swallowed, reasons } = result;
        return { dropped, swallowed, reasons };
    }

    /**
     * After the batch, a stored setting above the maximum a source written in it now sets (Volume
     * Range, a codec) is brought down to it, whoever wrote the source (B-107). Added as cascades.
     */
    private clampDependents(engineId: string, config: Record<string, unknown>, ops: PatchOp[]): PatchOp[] {
        const written = new Map<string, Set<string>>();
        for (const op of ops) {
            const [branch, id, field, key, ...deeper] = splitPath(op.path);
            if (branch !== 'modules' || field !== 'settings' || key === undefined || deeper.length > 0) continue;
            written.set(id, (written.get(id) ?? new Set<string>()).add(key));
        }
        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const clamps: PatchOp[] = [];
        for (const [id, sources] of written) {
            const settings = modules[id]?.settings as Record<string, unknown> | undefined;
            if (!settings) continue;
            const over = dependentsOverMaximum(this.schemaProps(engineId, modules[id]), settings, sources);
            for (const [key, value] of Object.entries(over)) {
                clamps.push({ op: 'replace', path: joinPath(['modules', id, 'settings', key]), value });
            }
        }
        return clamps;
    }

    /** A module's settings schema as the write check reads it: the engine's reported one, else the manifest's. */
    private schemaProps(engineId: string, stored: Record<string, unknown>): Record<string, Record<string, unknown>> {
        const mod: Record<string, unknown> = { pluginId: stored.pluginId, configSchema: stored.configSchema };
        this.pluginRegistry.overlayManifest(mod, this.runtime.getPluginSchemas(engineId));
        return (mod.configSchema as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {};
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
     * `/editor` ops go to the batch's `EditorBatch` instead (ADR-0030), which
     * also sees every emitted op to clean the layout up after removals.
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
        const editor = new EditorBatch(config);
        const out: Processed = { processed: [], cascades: [], published: [], dropped: [], swallowed: [], reasons: {} };
        const emit = (op: PatchOp, fromSender: boolean) => {
            out.processed.push(op);
            if (!fromSender) out.cascades.push(op);
            out.published.push({ op: idPath(op, arrays), fromSender });
            arrays.connections.track(op);
            arrays.interlocks.track(op);
        };
        ops.forEach((op, index) => {
            const result = isEditorPath(op.path)
                ? editor.onSenderOp(op, index)
                : dispatchRule(op, {
                      ...base,
                      connections: arrays.connections.snapshot() as Array<Record<string, unknown>>,
                      interlocks: arrays.interlocks.snapshot() as Array<{ id: string; members: string[] }>,
                  });
            if (result === 'swallowed') {
                out.swallowed.push(index);
                return;
            }
            const cascades = new Set(result.cascades);
            if (!result.processed.some((p) => !cascades.has(p))) out.dropped.push(index);
            for (const emitted of result.processed) {
                // Before the arrays move on, so a connection's index path still names it.
                const cleanup = editor.onEmitted(emitted, arrays.connections);
                emit(emitted, !cascades.has(emitted));
                cleanup.forEach((c) => emit(c, false));
            }
        });
        editor.finish(out);
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

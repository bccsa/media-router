import { LOG_RING_MAX, appendRing, applyTreeOp, joinPath, splitPath, type PatchOp } from '@media-router/shared-types';

type State = Record<string, unknown>;

export interface StateChange {
    moduleId: string;
    prev: State | undefined;
    next: State;
}

/**
 * What engines report at runtime, per engine: module states, VU, system
 * stats, identity data (ip, hostname, build, schemas, device lists) and the
 * recent log ring. Cleared when the engine goes offline.
 */
export class RuntimeCache {
    static readonly LOG_MAX = LOG_RING_MAX;
    private states = new Map<string, Record<string, State>>();
    /** Removed module ids — a late state batch must not bring them back. */
    private removed = new Map<string, Set<string>>();
    private data = new Map<string, Map<string, unknown>>();
    private logs = new Map<string, unknown[]>();
    private vu = new Map<string, Record<string, number[]>>();

    /** Merge whole-module states; returns what changed, tombstoned ids dropped. */
    mergeStates(engineId: string, incoming: Record<string, unknown>): StateChange[] {
        const tombstones = this.removed.get(engineId);
        let own = this.states.get(engineId);
        if (!own) this.states.set(engineId, (own = {}));
        const changes: StateChange[] = [];
        for (const [moduleId, raw] of Object.entries(incoming)) {
            if (tombstones?.has(moduleId) || raw === null || typeof raw !== 'object') continue;
            const { vuData: _vu, ...next } = raw as State;
            changes.push({ moduleId, prev: own[moduleId], next });
            own[moduleId] = next;
        }
        return changes;
    }

    /**
     * Apply leaf state ops (`/modules/<id>/…`, from `statePatch`); returns the
     * ops that applied — tombstoned modules are skipped.
     */
    applyStateOps(engineId: string, ops: PatchOp[]): PatchOp[] {
        const tombstones = this.removed.get(engineId);
        let own = this.states.get(engineId);
        if (!own) this.states.set(engineId, (own = {}));
        const applied: PatchOp[] = [];
        for (const op of ops) {
            const [branch, moduleId, ...rest] = splitPath(op.path);
            if (branch !== 'modules' || !moduleId || rest.length === 0 || tombstones?.has(moduleId)) continue;
            const state = (own[moduleId] ??= {});
            if (applyTreeOp(state, { ...op, path: joinPath(rest) }) || op.op === 'remove') applied.push(op);
        }
        return applied;
    }

    getStates(engineId: string): Record<string, State> {
        return this.states.get(engineId) ?? {};
    }

    purgeModuleStates(engineId: string, moduleIds: string[]): void {
        if (moduleIds.length === 0) return;
        const own = this.states.get(engineId);
        const vu = this.vu.get(engineId);
        let tombstones = this.removed.get(engineId);
        if (!tombstones) this.removed.set(engineId, (tombstones = new Set()));
        for (const id of moduleIds) {
            if (own) delete own[id];
            if (vu) delete vu[id];
            tombstones.add(id);
        }
    }

    /** Ids can be re-added (undo); lift their tombstones. */
    clearModuleTombstones(engineId: string, moduleIds: string[]): void {
        const tombstones = this.removed.get(engineId);
        if (!tombstones) return;
        for (const id of moduleIds) tombstones.delete(id);
        if (tombstones.size === 0) this.removed.delete(engineId);
    }

    setData(engineId: string, topic: string, value: unknown): void {
        let own = this.data.get(engineId);
        if (!own) this.data.set(engineId, (own = new Map()));
        own.set(topic, value);
    }

    getData(engineId: string, topic: string): unknown {
        return this.data.get(engineId)?.get(topic);
    }

    /** Engine-reported effective schemas (pluginId → configSchema), issue #661. */
    getPluginSchemas(engineId: string): Record<string, unknown> | undefined {
        return this.getData(engineId, 'pluginSchemas') as Record<string, unknown> | undefined;
    }

    /** Device lists keyed by type. */
    getDevices(engineId: string): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [topic, value] of this.data.get(engineId) ?? []) {
            if (topic.startsWith('devices:')) out[topic.slice('devices:'.length)] = value;
        }
        return out;
    }

    appendLogs(engineId: string, batch: unknown[]): void {
        let buffer = this.logs.get(engineId);
        if (!buffer) this.logs.set(engineId, (buffer = []));
        appendRing(buffer, batch);
    }

    getLogs(engineId: string): unknown[] {
        return this.logs.get(engineId) ?? [];
    }

    setVu(engineId: string, batch: Record<string, number[]>): void {
        const tombstones = this.removed.get(engineId);
        let own = this.vu.get(engineId);
        if (!own) this.vu.set(engineId, (own = {}));
        for (const [moduleId, levels] of Object.entries(batch)) {
            if (!tombstones?.has(moduleId)) own[moduleId] = levels;
        }
    }

    getVu(engineId: string): Record<string, number[]> {
        return this.vu.get(engineId) ?? {};
    }

    clearEngine(engineId: string): void {
        this.states.delete(engineId);
        this.removed.delete(engineId);
        this.data.delete(engineId);
        this.logs.delete(engineId);
        this.vu.delete(engineId);
    }

    /** Re-key everything after an engine_id rename. */
    rename(oldId: string, newId: string): void {
        if (oldId === newId) return;
        for (const map of [this.states, this.removed, this.data, this.logs, this.vu] as Array<Map<string, unknown>>) {
            const value = map.get(oldId);
            if (value === undefined) continue;
            map.delete(oldId);
            map.set(newId, value);
        }
    }
}

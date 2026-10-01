import * as shared from '@media-router/shared-types';
import type { PatchOp, TreeOp, TreeRenamed } from '@media-router/shared-types';
import { useEngineStore, type EngineState, type SystemStats } from '@/stores/engines';
import { useVuStore } from '@/stores/vuMeters';
import { useLogStore, type LogEntry } from '@/stores/logs';
import { useDeviceStore } from '@/stores/devices';
import { useEngineGroupsStore } from '@/stores/engineGroups';
import { useTreeDataStore } from '@/stores/treeData';
import type { Device } from '@media-router/shared-types';

const { splitPath, joinPath, parsePattern, overlaps, applyTreeOp, ENGINE_BRANCHES } = shared;

/** Module fields the engine reports at runtime: written in place, no Map rebuild. */
const RUNTIME_FIELDS = new Set([
    'running', 'ready', 'health', 'pendingRestart', 'liveUpdatableParams', 'statusData',
    'dynamicStatusSections', 'badges', 'fieldOptions', 'error', 'warnings',
]);

export interface MirrorHooks {
    onRebootFailed(engineId: string, reason: string): void;
}

type Obj = Record<string, any>;

/** Route tree ops (snapshot or delta) into the Pinia stores. */
export function applyTreeOps(ops: TreeOp[], hooks: MirrorHooks): void {
    const appends = new Map<string, LogEntry[]>();
    for (const op of ops) {
        const seg = splitPath(op.path);
        if (seg.length === 0 && op.op !== 'remove') {
            applyTreeOps(Object.entries((op.value as Obj) ?? {}).map(([k, value]) => ({ op: 'add', path: joinPath([k]), value })), hooks);
        } else if (seg[0] === 'engines') {
            engineOp(seg.slice(1), op, appends, hooks);
        } else if (seg[0] === 'groups') {
            groupOp(seg.slice(1), op);
        } else if (seg[0] === 'settings' || seg[0] === 'plugins') {
            useTreeDataStore().apply(seg, op);
        }
    }
    flushAppends(appends);
}

function flushAppends(appends: Map<string, LogEntry[]>, engineId?: string): void {
    for (const [id, entries] of appends) {
        if (engineId !== undefined && id !== engineId) continue;
        useLogStore().addEntries(id, entries);
        appends.delete(id);
    }
}

function engineOp(seg: string[], op: TreeOp, appends: Map<string, LogEntry[]>, hooks: MirrorHooks): void {
    const engines = useEngineStore();
    const [engineId, branch, ...rest] = seg;
    if (engineId === undefined) {
        if (op.op !== 'remove') {
            for (const [id, v] of Object.entries((op.value as Obj) ?? {})) engineOp([id], { op: 'add', path: '', value: v }, appends, hooks);
        }
        return;
    }
    if (branch === undefined) {
        if (op.op === 'remove') removeEngine(engineId);
        else for (const b of ENGINE_BRANCHES) {
            const v = (op.value as Obj | undefined)?.[b];
            if (v !== undefined) engineOp([engineId, b], { op: 'add', path: '', value: v }, appends, hooks);
        }
        return;
    }
    switch (branch) {
        case 'info':
            return infoOp(engineId, rest, op);
        case 'system':
            return systemOp(engineId, rest, op);
        case 'devices':
            return deviceOp(engineId, rest, op);
        case 'logs':
            if (rest.length === 0) {
                flushAppends(appends, engineId);
                useLogStore().setHistory(engineId, op.op === 'remove' ? [] : ((op.value as LogEntry[]) ?? []));
            } else if (rest[0] === '-' && op.op === 'add') {
                const list = appends.get(engineId) ?? [];
                list.push(op.value as LogEntry);
                appends.set(engineId, list);
            }
            return;
        case 'events': {
            const ev = op.value as Obj | undefined;
            if (op.op === 'add' && ev?.type === 'rebootFailed') hooks.onRebootFailed(engineId, String(ev.reason));
            return;
        }
        case 'profiles': {
            const current = engines.getEngine(engineId)?.profiles ?? {};
            const next = rest.length === 0 ? (op.op === 'remove' ? undefined : (op.value as EngineState['profiles'])) : patched(current, rest, op);
            if (engines.getEngine(engineId)) engines.patchInfo(engineId, { profiles: next });
            return;
        }
        case 'modules':
            return moduleOp(engineId, rest, op);
        case 'connections':
        case 'interlocks':
            engines.applyEnginePatch(engineId, [{ op: op.op, path: joinPath([branch, ...rest]), value: op.value }], {
                skipUnchanged: op.w !== undefined,
            });
            return;
    }
}

function patched<T extends object>(base: T, rest: string[], op: PatchOp): T {
    const next = JSON.parse(JSON.stringify(base));
    applyTreeOp(next, { ...op, path: joinPath(rest) });
    return next;
}

function infoOp(engineId: string, rest: string[], op: PatchOp): void {
    const engines = useEngineStore();
    if (rest.length === 0) {
        if (op.op === 'remove') removeEngine(engineId);
        else engines.patchInfo(engineId, (op.value as Partial<EngineState>) ?? {});
        return;
    }
    const engine = engines.ensureEngine(engineId) as unknown as Obj;
    const field = rest[0];
    const info = patched({ [field]: engine[field] }, rest, op);
    engines.patchInfo(engineId, { [field]: info[field] } as Partial<EngineState>);
}

function systemOp(engineId: string, rest: string[], op: PatchOp): void {
    const engines = useEngineStore();
    const current = engines.getEngine(engineId)?.system;
    if (rest.length === 0) engines.setSystem(engineId, op.op === 'remove' ? undefined : (op.value as SystemStats));
    else engines.setSystem(engineId, patched((current ?? {}) as SystemStats, rest, op));
}

function deviceOp(engineId: string, rest: string[], op: PatchOp): void {
    const devices = useDeviceStore();
    if (rest.length === 0) {
        devices.clear(engineId);
        if (op.op !== 'remove') {
            for (const [type, list] of Object.entries((op.value as Obj) ?? {})) devices.set(engineId, type, list as Device[]);
        }
    } else if (rest.length === 1) {
        devices.set(engineId, rest[0], op.op === 'remove' ? [] : (op.value as Device[]));
    }
}

function moduleOp(engineId: string, rest: string[], op: TreeOp): void {
    const engines = useEngineStore();
    const vu = useVuStore();
    const [moduleId, field, ...deeper] = rest;
    if (field === 'vu' && deeper.length === 0) {
        if (op.op === 'remove') vu.remove(engineId, moduleId);
        else vu.update(engineId, moduleId, op.value as number[]);
        return;
    }
    if (field !== undefined && RUNTIME_FIELDS.has(field)) {
        engines.applyRuntimeOp(engineId, moduleId, { op: op.op, path: joinPath([field, ...deeper]), value: op.value });
        return;
    }
    engines.applyEnginePatch(engineId, [{ op: op.op, path: joinPath(['modules', ...rest]), value: op.value }], {
        skipUnchanged: op.w !== undefined,
    });
    // A snapshot's module nodes carry their last VU reading.
    if (op.op !== 'remove' && field === undefined) {
        const mods = (moduleId === undefined ? op.value : { [moduleId]: op.value }) as Obj | undefined;
        for (const [id, m] of Object.entries(mods ?? {})) if (Array.isArray(m?.vu)) vu.update(engineId, id, m.vu);
    }
}

function groupOp(seg: string[], op: PatchOp): void {
    const groups = useEngineGroupsStore();
    const [gid, field] = seg;
    if (gid === undefined) {
        if (op.op !== 'remove') groups.setAll(Object.values((op.value as Obj) ?? {}));
    } else if (field === undefined) {
        if (op.op === 'remove') groups.removeGroup(gid);
        else groups.upsertFromRow(op.value as Obj);
    }
}

function removeEngine(engineId: string): void {
    useEngineStore().removeEngine(engineId);
    useVuStore().clear(engineId);
    useLogStore().clear(engineId);
    useDeviceStore().clear(engineId);
}

/** Clear what no remaining subscription covers — the mirror holds only live data. */
export function dropUncovered(gone: string[], remaining: string[]): void {
    const goneP = gone.map(parsePattern);
    const keepP = remaining.map(parsePattern);
    const engines = useEngineStore();
    const was = (path: string[]) => goneP.some((p) => overlaps(p, path));
    const still = (path: string[]) => keepP.some((p) => overlaps(p, path));
    const dropped = (path: string[]) => was(path) && !still(path);
    for (const engineId of engines.engines.keys()) {
        const at = (b: string) => ['engines', engineId, b];
        const graph = (['modules', 'connections', 'interlocks', 'profiles'] as const).filter((b) => dropped(at(b)));
        if (graph.length > 0) engines.dropGraph(engineId, graph);
        if (graph.includes('modules')) useVuStore().clear(engineId);
        if (dropped(at('system'))) engines.setSystem(engineId, undefined);
        if (dropped(at('devices'))) useDeviceStore().clear(engineId);
        if (dropped(at('logs'))) useLogStore().clear(engineId);
    }
    if (dropped(['settings'])) useTreeDataStore().drop('settings');
    if (dropped(['plugins'])) useTreeDataStore().drop('plugins');
}

/** An engine was renamed on the manager: re-key everything held under the old id. */
export function applyRenamed({ from, to }: TreeRenamed): void {
    const [root, oldId] = splitPath(from);
    const [, newId] = splitPath(to);
    if (root !== 'engines' || !oldId || !newId) return;
    useEngineStore().renameEngine(oldId, newId);
    useLogStore().rename(oldId, newId);
    useDeviceStore().rename(oldId, newId);
    useVuStore().rename(oldId, newId);
}

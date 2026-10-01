import { META_RUNTIME_FIELDS, diffValues, dropUndefined, joinPath, touchedModules, type PatchOp } from '@media-router/shared-types';
import { DerivedNodes, type PublishOptions, type TopicBus } from '@media-router/topic-tree';
import type { EngineView } from './EngineView.js';
import type { StateChange } from './RuntimeCache.js';

/** One op of a processed config patch, and whether its sender already applied it. */
export interface ConfigOp {
    op: PatchOp;
    fromSender: boolean;
}

/** Runtime fields an offline engine no longer reports (was the UI's clearEngineRuntime). */
const OFFLINE_CLEARED = ['error', 'statusData', 'badges', 'fieldOptions', 'vu'];

const enginePath = (engineId: string, ...rest: string[]) => joinPath(['engines', engineId, ...rest]);
const metaModules = (engineId: string) => ['meta', 'engines', engineId, 'modules'];


/** Turns manager-side changes into tree ops on the bus. */
export class TreePublisher {
    private lastInfo = new Map<string, Record<string, unknown>>();
    /** `/meta/engines/<id>/modules/<mid>` descriptors, republished while subscribed. */
    private readonly meta: DerivedNodes;

    constructor(
        private readonly bus: TopicBus,
        private readonly view: EngineView,
    ) {
        this.meta = new DerivedNodes(bus, (p) => view.moduleMeta(p[2], p[4]));
    }

    publish(ops: PatchOp[], opts?: PublishOptions): void {
        if (ops.length > 0) this.bus.publish(ops, opts);
    }

    /** Re-read an engine's info and publish what changed; a vanished engine is removed. */
    info(engineId: string): void {
        const next = this.view.info(engineId);
        const prev = this.lastInfo.get(engineId);
        if (!next) {
            this.lastInfo.delete(engineId);
            this.meta.forget(['meta', 'engines', engineId]);
            if (prev) {
                this.publish([{ op: 'remove', path: enginePath(engineId) }]);
                this.publish([{ op: 'remove', path: joinPath(['meta', 'engines', engineId]) }], { named: true });
            }
            return;
        }
        this.lastInfo.set(engineId, next);
        if (!prev) this.publish([{ op: 'add', path: enginePath(engineId, 'info'), value: next }]);
        else this.publish(diffValues(prev, next, ['engines', engineId, 'info']));
    }

    /** Publish some info fields without re-reading the engine row and profile. */
    infoFields(engineId: string, fields: Record<string, unknown>): void {
        const prev = this.lastInfo.get(engineId);
        if (!prev) {
            this.info(engineId);
            return;
        }
        const next = dropUndefined<Record<string, unknown>>({ ...prev, ...fields });
        this.lastInfo.set(engineId, next);
        this.publish(diffValues(prev, next, ['engines', engineId, 'info']));
    }

    /** Module runtime as leaf ops; `replace`, so a mirror without the module drops them. */
    runtime(engineId: string, changes: StateChange[]): void {
        const ops: PatchOp[] = [];
        for (const { moduleId, prev, next } of changes) {
            for (const op of diffValues(prev ?? {}, next, ['engines', engineId, 'modules', moduleId])) {
                ops.push(op.op === 'add' ? { ...op, op: 'replace' } : op);
            }
        }
        this.publish(ops);
        const prefix = enginePath(engineId).length;
        this.refreshMeta(engineId, touchedModules(ops.map((o) => ({ ...o, path: o.path.slice(prefix) })), META_RUNTIME_FIELDS));
    }

    /** Leaf state ops from a router's `statePatch` (engine-relative paths). */
    statePatch(engineId: string, ops: PatchOp[]): void {
        this.publish(ops.map((op) => ({ ...op, path: enginePath(engineId) + op.path })));
        this.refreshMeta(engineId, touchedModules(ops, META_RUNTIME_FIELDS));
    }

    /** These modules' descriptor inputs changed (settings, schema, live params). */
    metaChanged(engineId: string, moduleIds: Iterable<string>): void {
        for (const id of moduleIds) this.meta.refresh([...metaModules(engineId), id]);
    }

    vu(engineId: string, batch: Record<string, number[]>): void {
        this.publish(
            Object.entries(batch).map(([moduleId, value]) => ({
                op: 'replace' as const,
                path: enginePath(engineId, 'modules', moduleId, 'vu'),
                value,
            })),
        );
    }

    system(engineId: string, prev: unknown, next: Record<string, unknown>): void {
        this.publish(diffValues(prev ?? {}, next, ['engines', engineId, 'system']));
    }

    logs(engineId: string, batch: unknown[]): void {
        this.publish(batch.map((value) => ({ op: 'add' as const, path: enginePath(engineId, 'logs', '-'), value })));
    }

    devices(engineId: string, type: string, devices: unknown): void {
        this.publish([{ op: 'add', path: enginePath(engineId, 'devices', type), value: devices }]);
    }

    /** A transient notice (not retained): e.g. a failed host reboot. */
    event(engineId: string, event: Record<string, unknown>): void {
        this.publish([{ op: 'add', path: enginePath(engineId, 'events', '-'), value: { ...event, time: new Date().toISOString() } }]);
    }

    /** Runtime reset of an engine that went offline, for every placed module. */
    offline(engineId: string): void {
        const ops: PatchOp[] = [];
        for (const id of this.view.moduleIds(engineId)) {
            ops.push({ op: 'replace', path: enginePath(engineId, 'modules', id, 'running'), value: false });
            ops.push({ op: 'replace', path: enginePath(engineId, 'modules', id, 'health'), value: 'stopped' });
            for (const f of OFFLINE_CLEARED) ops.push({ op: 'remove', path: enginePath(engineId, 'modules', id, f) });
        }
        ops.push({ op: 'remove', path: enginePath(engineId, 'system') });
        ops.push({ op: 'replace', path: enginePath(engineId, 'devices'), value: {} });
        ops.push({ op: 'replace', path: enginePath(engineId, 'logs'), value: [] });
        this.publish(ops);
        this.info(engineId);
        // Live params were engine-reported; the schema's x-live applies again.
        this.refreshAllMeta(engineId);
    }

    /** Processed config ops (engine-relative, id paths); the sender's own come back tagged. */
    config(engineId: string, entries: ConfigOp[], senderId: string, writeId?: number): void {
        const prefix = enginePath(engineId);
        for (const { op, fromSender } of entries) {
            const prefixed = { ...op, path: prefix + op.path };
            this.bus.publish([prefixed], fromSender ? { origin: senderId, writeId } : {});
        }
        this.refreshMeta(engineId, touchedModules(entries.map((e) => e.op)));
    }

    /** Whole graph replace, dashboards included — profile activation. */
    graph(engineId: string): void {
        this.publish([
            { op: 'replace', path: enginePath(engineId, 'modules'), value: this.view.modules(engineId) },
            { op: 'replace', path: enginePath(engineId, 'connections'), value: this.view.branch(engineId, 'connections') },
            { op: 'replace', path: enginePath(engineId, 'interlocks'), value: this.view.branch(engineId, 'interlocks') },
            { op: 'replace', path: enginePath(engineId, 'dashboards'), value: this.view.branch(engineId, 'dashboards') },
        ]);
        this.profiles(engineId);
        this.info(engineId);
        this.refreshAllMeta(engineId);
    }

    private refreshAllMeta(engineId: string): void {
        this.meta.refreshChildren(metaModules(engineId), this.view.moduleIds(engineId));
    }

    private refreshMeta(engineId: string, touched: Set<string> | 'all'): void {
        if (touched === 'all') this.refreshAllMeta(engineId);
        else this.metaChanged(engineId, touched);
    }

    profiles(engineId: string): void {
        this.publish([{ op: 'replace', path: enginePath(engineId, 'profiles'), value: this.view.profiles(engineId) }]);
    }

    renamed(oldId: string, newId: string): void {
        this.bus.renamePrefix(['engines', oldId], ['engines', newId]);
        this.bus.renamePrefix(['meta', 'engines', oldId], ['meta', 'engines', newId]);
        this.meta.forget(['meta', 'engines', oldId]);
        this.lastInfo.delete(oldId);
        this.publish([{ op: 'remove', path: enginePath(oldId) }]);
        this.info(newId);
    }
}

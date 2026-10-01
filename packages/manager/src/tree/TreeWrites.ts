import {
    ModuleWriteCheck,
    joinPath,
    splitPath,
    type PatchOp,
    type WriteRejection,
    type WriteResult,
} from '@media-router/shared-types';
import type { TopicBus, TreeCaller } from '@media-router/topic-tree';
import type { PatchRouter } from '../PatchRouter.js';
import type { EngineView } from './EngineView.js';
import type { AdminWrites } from './AdminWrites.js';

export interface WriteItem {
    index: number;
    op: PatchOp;
    path: string[];
}

const ENGINE_INFO_FIELDS = ['name', 'running', 'activeProfile'];
const CONNECTION_FIELD = /^[A-Za-z][A-Za-z0-9]*$/;
const INTERLOCK_FIELDS = ['name', 'members', 'color'];

/** Which handler takes an op; consecutive ops with one key are applied together. */
function groupKey(path: string[], op: PatchOp): string {
    const [root, id, branch, field] = path;
    if (root === 'engines' && id) {
        if (path.length === 2 && op.op === 'remove') return 'engine-delete';
        if (branch === 'modules' || branch === 'connections' || branch === 'interlocks') return `config:${id}`;
        if (branch === 'info' && path.length === 4 && (field === 'groupId' || field === 'sortOrder')) return 'reorder';
        if (branch === 'info' && path.length === 4 && ENGINE_INFO_FIELDS.includes(field)) return `info:${id}`;
        if (branch === 'profiles' && path.length === 4) return `profiles:${id}`;
    }
    if (root === 'groups' || root === 'settings') return root;
    return 'none';
}

/** Browser writes (ADR-0024): split by target, checked per op, applied in order. */
export class TreeWrites {
    constructor(
        private readonly patchRouter: PatchRouter,
        private readonly view: EngineView,
        private readonly admin: AdminWrites,
        private readonly bus: Pick<TopicBus, 'echo'>,
    ) {}

    async handle(caller: TreeCaller, ops: PatchOp[], writeId: number): Promise<WriteResult> {
        const items: WriteItem[] = ops.map((op, index) => ({ op, index, path: splitPath(op.path) }));
        const rejected: WriteRejection[] = [];
        let i = 0;
        while (i < items.length) {
            const key = groupKey(items[i].path, items[i].op);
            let j = i + 1;
            while (j < items.length && groupKey(items[j].path, items[j].op) === key) j++;
            rejected.push(...(await this.apply(key, caller, items.slice(i, j), writeId)));
            i = j;
        }
        return { rejected };
    }

    private async apply(key: string, caller: TreeCaller, group: WriteItem[], writeId: number): Promise<WriteRejection[]> {
        const [kind, engineId] = key.split(':');
        switch (kind) {
            case 'config':
                return this.config(caller, engineId, group, writeId);
            case 'none':
                return group.map((g) => reject(g, 'not writable'));
            default: {
                const rejected = await this.admin.apply(kind, engineId, group);
                this.echoAccepted(caller, group, rejected, writeId);
                return rejected;
            }
        }
    }

    /** Admin handlers publish untagged; the writer still gets each op back with its write id. */
    private echoAccepted(caller: TreeCaller, group: WriteItem[], rejected: WriteRejection[], writeId: number): void {
        const failed = new Set(rejected.map((r) => r.index));
        for (const { index, op } of group) {
            if (!failed.has(index) && !op.path.endsWith('/-')) this.bus.echo(caller.socketId, op.path, writeId);
        }
    }

    /** Module/connection/interlock ops of one engine → checks → PatchRouter. */
    private config(caller: TreeCaller, engineId: string, group: WriteItem[], writeId: number): WriteRejection[] {
        if (!this.view.exists(engineId)) return group.map((g) => reject(g, 'unknown engine'));
        const rejected: WriteRejection[] = [];
        const accepted: WriteItem[] = [];
        const checks = new ModuleWriteCheck((id) => this.view.module(engineId, id));
        const added = new Set<string>();
        for (const item of group) {
            const reason = this.checkConfigOp(item, checks, added);
            if (reason) rejected.push(reject(item, reason));
            else accepted.push(item);
        }
        const rel = accepted.map((a) => ({ ...a.op, path: joinPath(a.path.slice(2)) }));
        const dropped = this.patchRouter.onPatch(caller.socketId, engineId, rel, writeId);
        for (const d of dropped) rejected.push(reject(accepted[d], 'not applied'));
        return rejected;
    }

    private checkConfigOp({ op, path }: WriteItem, checks: ModuleWriteCheck, added: Set<string>): string | null {
        const [, , branch, id, field] = path;
        const depth = path.length - 2;
        if (branch === 'modules') {
            if (depth === 2) {
                if (op.op === 'remove') return null;
                const pluginId = (op.value as { pluginId?: unknown } | undefined)?.pluginId;
                if (op.op !== 'add' || typeof pluginId !== 'string') return 'a module add needs a pluginId';
                added.add(id);
                return null;
            }
            return added.has(id) ? null : checks.check(id, path.slice(4), op);
        }
        if (branch === 'connections') {
            if (depth === 2 && id === '-') return op.op === 'add' ? null : 'not writable';
            if (depth === 2) return op.op === 'remove' || op.op === 'replace' ? null : 'not writable';
            return depth === 3 && CONNECTION_FIELD.test(field) && op.op !== 'remove' ? null : 'not writable';
        }
        if (depth === 2 && id === '-') return op.op === 'add' ? null : 'not writable';
        if (depth === 2) return op.op === 'remove' ? null : 'not writable';
        return depth === 3 && INTERLOCK_FIELDS.includes(field) && op.op === 'replace' ? null : 'not writable';
    }
}

export function reject(item: WriteItem, reason: string): WriteRejection {
    return { index: item.index, path: item.op.path, reason };
}

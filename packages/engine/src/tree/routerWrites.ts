import {
    ModuleWriteCheck,
    splitPath,
    type DescribableModule,
    type PatchOp,
    type WriteRejection,
    type WriteResult,
} from '@media-router/shared-types';
import { TreeCallError } from '@media-router/topic-tree';
import type { RouterTree } from './RouterTree.js';

/** What a router's tree may do to its engine. */
export interface RouterActions {
    /** Apply value ops like a local-panel patch (live apply + forward to the manager). */
    patch(senderId: string, ops: PatchOp[]): void;
    setRunning(running: boolean): void;
    restartModule(instanceId: string): void;
    reboot(): void;
    managerConnected(): boolean;
}

/**
 * Writes straight to a router (ADR-0024): values only — module settings and
 * `enabled`, plus `info/running`. Structure stays with the manager.
 */
export function routerWrites(
    tree: RouterTree,
    actions: RouterActions,
    socketId: string,
    ops: PatchOp[],
    writeId: number,
): WriteResult {
    const rejected: WriteRejection[] = [];
    const accepted: PatchOp[] = [];
    const checks = new ModuleWriteCheck((id) => tree.view.module(id) as DescribableModule | undefined);
    ops.forEach((op, index) => {
        const reason = check(checks, op);
        if (reason) rejected.push({ index, path: op.path, reason });
        else accepted.push(op);
    });
    const values = accepted.filter((op) => op.path !== '/info/running');
    if (values.length > 0) {
        actions.patch(socketId, values);
        tree.bus.publish(values, { origin: socketId, writeId });
    }
    const running = accepted.find((op) => op.path === '/info/running');
    if (running) {
        actions.setRunning(running.value as boolean);
        tree.bus.publish([running], { origin: socketId, writeId });
    }
    return { rejected };
}

function check(checks: ModuleWriteCheck, op: PatchOp): string | null {
    const seg = splitPath(op.path);
    if (op.path === '/info/running') {
        return op.op === 'replace' && typeof op.value === 'boolean' ? null : 'expected boolean';
    }
    const [branch, id, field] = seg;
    const valueField = (field === 'settings' && seg.length === 4) || (field === 'enabled' && seg.length === 3);
    if (branch !== 'modules' || !valueField) return 'not writable on a router';
    return checks.check(id, seg.slice(2), op);
}

/** Router calls: module restart, and a device reboot that needs `confirm` without a manager. */
export function routerCall(actions: RouterActions, path: string, method: string, args: unknown): unknown {
    const seg = splitPath(path);
    if (seg.length === 2 && seg[0] === 'modules' && method === 'restart') {
        actions.restartModule(seg[1]);
        return {};
    }
    if (seg.length === 0 && method === 'reboot') {
        const confirmed = (args as { confirm?: unknown } | undefined)?.confirm === true;
        if (!actions.managerConnected() && !confirmed) {
            throw new TreeCallError(
                'The manager is unreachable: after a restart this router stays stopped until it is back. Call again with confirm: true.',
            );
        }
        actions.reboot();
        return {};
    }
    throw new TreeCallError(`no method ${method} on ${path}`);
}

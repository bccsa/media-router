import { diffValues, type ModuleRuntimeState, type PatchOp } from '@media-router/shared-types';

type Lean = Omit<ModuleRuntimeState, 'vuData'>;

/**
 * Module runtime state as leaf ops (`/modules/<id>/…`), each module diffed
 * against the last state seen (ADR-0025). VU is left out — it has its own
 * channel. New keys come out as `replace`, so a mirror without the module
 * drops them instead of growing a half module.
 */
export class RuntimeDiffer {
    private last = new Map<string, Lean>();

    update(instanceId: string, state: ModuleRuntimeState): PatchOp[] {
        const { vuData: _vu, ...next } = state;
        const prev = this.last.get(instanceId);
        this.last.set(instanceId, JSON.parse(JSON.stringify(next)) as Lean);
        return diffValues(prev ?? {}, next, ['modules', instanceId]).map((op) =>
            op.op === 'add' ? { ...op, op: 'replace' as const } : op,
        );
    }

    /** Last state per module, VU stripped — a full snapshot. */
    snapshot(): Record<string, Lean> {
        return Object.fromEntries(this.last);
    }

    drop(instanceId: string): void {
        this.last.delete(instanceId);
    }
}

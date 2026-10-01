import type { ModuleRuntimeState } from '@media-router/shared-types';
import { ModuleStateBatcher } from './ModuleStateBatcher.js';
import { RuntimeDiffer } from './RuntimeDiffer.js';
import { StatePatchBatcher } from './StatePatchBatcher.js';
import type { RouterTree } from '../tree/RouterTree.js';

/** Full-state resyncs in patch mode: every 6th 10 s heartbeat (ADR-0025). */
const PATCH_MODE_SNAPSHOT_EVERY = 6;

/** The slice of ManagerConnection this needs. */
export interface StateLink {
    send(topic: string, message: unknown): void;
    sendState(states: Record<string, unknown>): void;
}

/**
 * Module runtime state on its way to the manager and the router tree. One
 * leaf diff feeds the tree and, once the manager's `hello` offers it,
 * `statePatch` instead of whole states (ADR-0025). Whole states go through
 * batch + dedup (see ModuleStateBatcher for the traffic math).
 *
 * The full snapshot (connect + heartbeat) is best-effort on purpose: the
 * resync repeats, so a drop self-heals next beat; guaranteed delivery turned
 * each snapshot into a 10x retransmit storm on lossy uplinks. Whole-state
 * mode sends it every beat, patch mode every 6th — a seq gap the manager
 * sees asks for one sooner (`stateResync`).
 */
export class ManagerStateSync {
    private readonly batcher: ModuleStateBatcher;
    private readonly patches: StatePatchBatcher;
    private readonly differ = new RuntimeDiffer();
    private patchMode = false;
    private beats = 0;

    constructor(
        private readonly link: StateLink,
        private readonly allStates: () => Record<string, ModuleRuntimeState>,
        private readonly tree: RouterTree | null,
    ) {
        this.batcher = new ModuleStateBatcher((batch) => link.sendState(batch));
        this.patches = new StatePatchBatcher((msg) => link.send('statePatch', msg));
    }

    stateChange(instanceId: string, state: ModuleRuntimeState): void {
        const ops = this.differ.update(instanceId, state);
        this.tree?.moduleOps(ops);
        if (this.patchMode) this.patches.push(ops);
        else this.batcher.enqueue(instanceId, state);
    }

    drop(instanceId: string): void {
        this.batcher.drop(instanceId);
        this.differ.drop(instanceId);
    }

    /** The manager's `hello`: baseline with a snapshot, then leaf ops. */
    hello(hello: unknown): void {
        const features = (hello as { features?: unknown } | null)?.features;
        if (!Array.isArray(features) || !features.includes('statePatch')) return;
        this.patchMode = true;
        this.snapshot();
    }

    /** Full snapshot; supersedes any pending batch and restarts the patch count. */
    snapshot(): void {
        this.patches.reset();
        const lean = this.batcher.snapshot(this.allStates());
        if (lean) this.link.sendState(lean);
    }

    connected(): void {
        this.beats = 0;
        this.snapshot();
    }

    heartbeat(): void {
        if (!this.patchMode || ++this.beats % PATCH_MODE_SNAPSHOT_EVERY === 0) this.snapshot();
    }

    disconnected(): void {
        this.patchMode = false;
        this.patches.reset();
        this.batcher.reset();
    }
}

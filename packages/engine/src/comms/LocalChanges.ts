import {
    applyJsonPatch,
    coerceArray,
    createLogger,
    splitPath,
    type ConfigPushTag,
    type PatchOp,
} from '@media-router/shared-types';

const log = createLogger('LocalChanges');

/** The slice of ManagerConnection this needs. */
export interface ManagerLink {
    readonly isConnected: boolean;
    send(topic: string, message: unknown, options?: { guaranteeDelivery?: boolean }): void;
}

/** A push's `_push` tag; absent from managers older than ADR-0025. */
export type ConfigPush = Partial<ConfigPushTag>;

type Obj = Record<string, unknown>;

/**
 * Changes this router makes to its own config and run state — operator
 * writes (LCP, router tree) and plugin auto-writes (ADR-0025). Linked: sent
 * to the manager with guaranteed delivery. Link down, or up but the connect
 * push not merged yet: kept in an in-memory journal, latest op per path.
 */
export class LocalChanges {
    /** Profile of the running config, from the last tagged push. */
    profile: string | undefined;
    private journal = new Map<string, PatchOp>();
    private runChange: boolean | undefined;
    private synced = false;

    constructor(private readonly link: ManagerLink) {}

    config(ops: PatchOp[]): void {
        if (ops.length === 0) return;
        if (this.live) this.link.send('patch', { ops }, { guaranteeDelivery: true });
        else for (const op of ops) this.record(op);
    }

    running(running: boolean): void {
        if (this.live) this.sendRunning(running);
        else this.runChange = running;
    }

    /** The link dropped: journal from now on. */
    linkDown(): void {
        this.synced = false;
    }

    /** Whether an outage Start/Stop is waiting to be reported; clears it. */
    takeRunChange(): boolean {
        const changed = this.runChange !== undefined;
        this.runChange = undefined;
        return changed;
    }

    /**
     * Lay the journal over a `connect` push of the profile this router runs:
     * the on-site value wins; entries for modules or connections the manager
     * no longer has are dropped. Any other push drops the journal. Returns the
     * config to run and the ops to replay to the manager.
     */
    merge(pushed: Obj, push: ConfigPush | undefined): { config: Obj; replay: PatchOp[] } {
        const ops = [...this.journal.values()];
        this.journal.clear();
        const sameProfile = push?.reason === 'connect' && push.profile !== undefined && push.profile === this.profile;
        this.profile = push?.profile;
        if (ops.length === 0) return { config: pushed, replay: [] };
        if (!sameProfile) {
            log.warn({ dropped: ops.map((o) => o.path), profile: push?.profile }, 'Outage changes dropped: the manager pushed another profile');
            return { config: pushed, replay: [] };
        }
        const modules = (pushed.modules ?? {}) as Obj;
        const connections = new Set(coerceArray<{ id?: unknown }>(pushed.connections).map((c) => c.id));
        const replay: PatchOp[] = [];
        const dropped: string[] = [];
        for (const op of ops) {
            const [branch, id] = splitPath(op.path);
            const known = branch === 'modules' ? id in modules : branch === 'connections' ? connections.has(id) : true;
            if (known) replay.push(op);
            else dropped.push(op.path);
        }
        if (dropped.length > 0) log.warn({ dropped }, 'Outage changes dropped: no longer in the manager config');
        const config = structuredClone(pushed);
        applyJsonPatch(config, replay);
        return { config, replay };
    }

    /** The connect push is applied: replay the journal upstream, then go live. */
    markSynced(replay: PatchOp[]): void {
        if (replay.length > 0) {
            log.info({ opCount: replay.length }, 'Replaying outage changes to the manager');
            this.link.send('patch', { ops: replay }, { guaranteeDelivery: true });
        }
        if (this.runChange !== undefined) this.sendRunning(this.runChange);
        this.runChange = undefined;
        this.synced = true;
    }

    private get live(): boolean {
        return this.synced && this.link.isConnected;
    }

    private sendRunning(running: boolean): void {
        this.link.send('lcpEngineCommand', { command: running ? 'start' : 'stop' }, { guaranteeDelivery: true });
    }

    /** A write to a node supersedes earlier writes below it. */
    private record(op: PatchOp): void {
        for (const path of this.journal.keys()) if (path.startsWith(`${op.path}/`)) this.journal.delete(path);
        this.journal.delete(op.path);
        this.journal.set(op.path, op);
    }
}

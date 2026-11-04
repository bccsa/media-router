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
    send(topic: string, message: unknown, options?: { guaranteeDelivery?: boolean; onAck?: () => void }): void;
}

/** A push's `_push` tag; absent from managers older than ADR-0025. */
export type ConfigPush = Partial<ConfigPushTag>;

type Obj = Record<string, unknown>;

/**
 * Changes this router makes to its own config and run state — operator
 * writes (LCP, router tree) and plugin auto-writes (ADR-0025). Linked: sent
 * to the manager with guaranteed delivery. Link down, or up but the connect
 * push not merged yet: kept in an in-memory journal, latest op per path.
 * What the manager had not acked when the link dropped goes back into it.
 */
export class LocalChanges {
    /** Profile of the running config, from the last tagged push. */
    profile: string | undefined;
    private journal = new Map<string, PatchOp>();
    /** Sent and not acked yet, latest op per path. */
    private unacked = new Map<string, PatchOp>();
    private runChange: boolean | undefined;
    /** A Start/Stop sent and not acked yet. */
    private runUnacked: { running: boolean } | undefined;
    private synced = false;
    /** This session's push was merged when the link dropped: if the manager keeps the session, none comes. */
    private resumable = false;

    constructor(private readonly link: ManagerLink) {}

    config(ops: PatchOp[]): void {
        if (ops.length === 0) return;
        if (this.live) this.sendOps(ops);
        else for (const op of ops) put(this.journal, op);
    }

    running(running: boolean): void {
        if (this.live) this.sendRunning(running);
        else this.runChange = running;
    }

    /** The link dropped: journal from now on, first what may have died with it unacked (#857). */
    linkDown(): void {
        this.resumable = this.synced;
        this.synced = false;
        for (const op of this.unacked.values()) put(this.journal, op);
        this.unacked.clear();
        if (this.runUnacked && this.runChange === undefined) this.runChange = this.runUnacked.running;
        this.runUnacked = undefined;
    }

    /**
     * The link is back on the session the manager kept, so no connect push
     * comes: the journal goes up as it is and changes go live again (#857).
     * A session still waiting for its push keeps waiting.
     */
    resumed(): void {
        if (!this.resumable) return;
        this.resumable = false;
        const replay = [...this.journal.values()];
        this.journal.clear();
        this.markSynced(replay);
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
            this.sendOps(replay);
        }
        if (this.runChange !== undefined) this.sendRunning(this.runChange);
        this.runChange = undefined;
        this.synced = true;
    }

    private get live(): boolean {
        return this.synced && this.link.isConnected;
    }

    /** Guaranteed; each op stays unacked until the manager acks it or a newer op takes its path. */
    private sendOps(ops: PatchOp[]): void {
        for (const op of ops) put(this.unacked, op);
        const onAck = () => {
            for (const op of ops) if (this.unacked.get(op.path) === op) this.unacked.delete(op.path);
        };
        this.link.send('patch', { ops }, { guaranteeDelivery: true, onAck });
    }

    private sendRunning(running: boolean): void {
        const sent = { running };
        this.runUnacked = sent;
        const onAck = () => {
            if (this.runUnacked === sent) this.runUnacked = undefined;
        };
        this.link.send('lcpEngineCommand', { command: running ? 'start' : 'stop' }, { guaranteeDelivery: true, onAck });
    }
}

/** Latest op per path: a write to a node supersedes earlier writes below it. */
function put(ops: Map<string, PatchOp>, op: PatchOp): void {
    for (const path of ops.keys()) if (path.startsWith(`${op.path}/`)) ops.delete(path);
    ops.delete(op.path);
    ops.set(op.path, op);
}

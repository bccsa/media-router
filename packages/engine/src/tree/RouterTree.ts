import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import {
    ROUTER_TREE_PATH,
    TREE_PROTOCOL,
    diffValues,
    joinPath,
    splitPath,
    type PatchOp,
} from '@media-router/shared-types';
import { TopicBus, attachTree } from '@media-router/topic-tree';
import type { RouterView } from './RouterView.js';
import { routerWrites, routerCall, type RouterActions } from './routerWrites.js';

/**
 * The router's tree server (ADR-0024) on the LCP's HTTP server under
 * `/tree`: engine dashboards read and write this box directly, with or
 * without a manager.
 */
export class RouterTree {
    readonly bus: TopicBus;
    private io: SocketIOServer | null = null;
    private lastInfo: Record<string, unknown> | undefined;
    private lastSystem: Record<string, unknown> | undefined;

    constructor(
        readonly view: RouterView,
        private readonly actions: RouterActions,
        private readonly build: () => string,
    ) {
        this.bus = new TopicBus(view);
    }

    attach(http: HttpServer): void {
        this.io = new SocketIOServer(http, {
            path: ROUTER_TREE_PATH,
            cors: { origin: (_origin, cb) => cb(null, true) },
        });
        attachTree(this.io, {
            bus: this.bus,
            hello: () => ({ proto: TREE_PROTOCOL, build: this.build() }),
            onWrite: (caller, ops, writeId) => routerWrites(this, this.actions, caller.socketId, ops, writeId),
            onCall: (_caller, path, method, args) => routerCall(this.actions, path, method, args),
        });
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => (this.io ? this.io.close(() => resolve()) : resolve()));
    }

    /** Leaf ops of module runtime state (from RuntimeDiffer). */
    moduleOps(ops: PatchOp[]): void {
        if (ops.length > 0) this.bus.publish(ops);
    }

    vu(instanceId: string, levels: number[]): void {
        this.view.vu[instanceId] = levels;
        this.bus.publish([{ op: 'replace', path: joinPath(['modules', instanceId, 'vu']), value: levels }]);
    }

    /**
     * Config ops as the engine applied them. Module paths are id-keyed and go
     * as-is; connection/interlock ops may carry array indexes, so those
     * arrays go whole; a root replace is the whole graph.
     */
    config(ops: PatchOp[]): void {
        const out: PatchOp[] = [];
        const arrays = new Set<string>();
        for (const op of ops) {
            const [branch, id, ...rest] = splitPath(op.path);
            if (branch === undefined) {
                for (const b of ['modules', 'connections', 'interlocks']) out.push({ op: 'replace', path: `/${b}`, value: this.view.branch(b) });
            } else if (branch === 'connections' || branch === 'interlocks') {
                arrays.add(branch);
            } else if (branch === 'modules') {
                // A module add carries the full node, manifest fields included.
                out.push(rest.length === 0 && op.op !== 'remove' ? { ...op, value: this.view.module(id) } : op);
            }
        }
        for (const b of arrays) out.push({ op: 'replace', path: `/${b}`, value: this.view.branch(b) });
        if (out.length > 0) this.bus.publish(out);
        this.info();
    }

    system(stats: Record<string, unknown>): void {
        this.view.system = stats;
        this.bus.publish(diffValues(this.lastSystem ?? {}, stats, ['system']));
        this.lastSystem = JSON.parse(JSON.stringify(stats));
    }

    devices(type: string, devices: unknown): void {
        if (JSON.stringify(this.view.devices[type]) === JSON.stringify(devices)) return;
        this.view.devices[type] = devices;
        this.bus.publish([{ op: 'add', path: joinPath(['devices', type]), value: devices }]);
    }

    logs(batch: unknown[]): void {
        this.view.appendLogs(batch);
        this.bus.publish(batch.map((value) => ({ op: 'add' as const, path: '/logs/-', value })));
    }

    /** Re-read info (run state, manager link, identity) and publish what changed. */
    info(): void {
        const next = this.view.branch('info') as Record<string, unknown>;
        this.bus.publish(diffValues(this.lastInfo ?? {}, next, ['info']));
        this.lastInfo = JSON.parse(JSON.stringify(next));
    }
}

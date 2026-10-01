import { reactive, readonly, ref, type Ref } from 'vue';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as wire from '@media-router/shared-types/browser';
import type { PatchOp } from '@media-router/shared-types';
import type { TreeOp, WriteResult } from '@media-router/shared-types/browser';
import { TreeClient, type TreeClientOptions } from '@/tree/TreeClient';

const { applyTreeOp, getAt, splitPath, WILDCARD } = wire;

/**
 * Where a dashboard's data comes from (ADR-0026): a router's own tree, or the
 * manager's. Router dashboards store router-relative paths; `prefix` makes
 * them absolute ('' on the router, `/engines/<id>` via the manager).
 */
export interface DashboardSource {
    readonly prefix: string;
    readonly connected: Readonly<Ref<boolean>>;
    /** The value at an absolute tree path; reactive. `T` is what the caller expects there, unchecked. */
    get<T = unknown>(path: string): T | undefined;
    /** A subscription to exactly this pattern has had its snapshot since connecting. */
    loaded(pattern: string): boolean;
    subscribe(patterns: string[]): () => void;
    write(ops: PatchOp[]): Promise<WriteResult>;
    call<T = unknown>(path: string, method: string, args?: unknown): Promise<T>;
    close(): void;
}

export interface SourceOptions {
    prefix: string;
    /** Server origin; default the page's own. */
    url?: string;
    /** Socket.IO path: `/tree` on a router. */
    path?: string;
    connectFn?: TreeClientOptions['connectFn'];
    reload?: () => void;
}

const covers = (a: string, b: string) => a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);

/** One tree connection of its own, mirrored into a reactive object. */
export function createSource(opts: SourceOptions): DashboardSource {
    const root = reactive<Record<string, unknown>>({});
    const connected = ref(false);
    const answered = reactive(new Set<string>());
    let snapshot: TreeOp[] = [];
    const client = new TreeClient({
        url: opts.url,
        path: opts.path,
        connectFn: opts.connectFn,
        reload: opts.reload,
        onOps: (ops, meta) => {
            if (meta.snapshot) snapshot = ops;
            for (const op of ops) applyTreeOp(root, op);
        },
        onSubscribed: (patterns) => {
            // A value that vanished while we were away comes back as no op at all.
            for (const p of patterns) {
                if (!p.includes(WILDCARD) && !snapshot.some((op) => covers(op.path, p))) applyTreeOp(root, { op: 'remove', path: p });
                answered.add(p);
            }
            snapshot = [];
        },
        onDropped: (gone) => gone.forEach((p) => answered.delete(p)),
        onConnected: (c) => {
            connected.value = c;
            if (!c) answered.clear();
        },
    });
    client.connect();
    return {
        prefix: opts.prefix,
        connected: readonly(connected),
        get: <T>(path: string) => getAt(root, splitPath(path)) as T | undefined,
        loaded: (pattern) => answered.has(pattern),
        subscribe: (patterns) => client.subscribe(patterns),
        write: (ops) => client.write(ops),
        call: <T>(path: string, method: string, args?: unknown) => client.call<T>(path, method, args),
        close: () => client.disconnect(),
    };
}

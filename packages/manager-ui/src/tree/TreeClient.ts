import { io, type Socket } from 'socket.io-client';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
// Its zod-free browser entry keeps the router's dashboard viewer small.
import * as wire from '@media-router/shared-types/browser';
import type { PatchOp } from '@media-router/shared-types';
import type { TreeAck, TreeErrorCode, TreeFrame, TreeHello, TreeOp, TreeRenamed, WriteResult } from '@media-router/shared-types/browser';

const { TREE_PROTOCOL, TREE_EVENTS, requiredProtocol } = wire;

/** A refused request; `code` says why, for the caller to act on. */
export class TreeRequestError extends Error {
    constructor(
        message: string,
        readonly code?: TreeErrorCode,
    ) {
        super(message);
    }
}

/** The code of a refused request, if it carried one. */
export const errorCode = (err: unknown): TreeErrorCode | undefined => (err instanceof TreeRequestError ? err.code : undefined);

/** A write whose echo has not come back within this is forgotten. */
const PENDING_MAX_MS = 5000;

export interface TreeClientOptions {
    /** Server origin; default the page's own. */
    url?: string;
    /** Socket.IO path; a router serves its tree on `/tree`. */
    path?: string;
    onOps(ops: TreeOp[], meta: { snapshot: boolean }): void;
    /** These patterns' snapshot has arrived: anything they cover and lack does not exist. */
    onSubscribed?(patterns: string[]): void;
    onDropped?(patterns: string[], remaining: string[]): void;
    onRenamed?(renamed: TreeRenamed): void;
    onConnected?(connected: boolean): void;
    reload?(): void;
    connectFn?: typeof io;
}

/**
 * Browser side of the tree (ADR-0024): ref-counted subscriptions that are
 * re-sent on every reconnect, writes with write ids, and echo settling — a
 * newer own write on a path hides both older echoes and other writers' ops
 * until its own echo brings the stored value.
 */
export class TreeClient {
    private socket: Socket | null = null;
    private refs = new Map<string, number>();
    /** Patterns renamed since a component subscribed with the old spelling. */
    private aliases = new Map<string, string>();
    private pending = new Map<string, { id: number; at: number }>();
    private writeSeq = 0;
    private build: string | null = null;

    constructor(private readonly opts: TreeClientOptions) {}

    get connected(): boolean {
        return this.socket?.connected ?? false;
    }

    connect(): void {
        this.disconnect();
        const connectFn = this.opts.connectFn ?? io;
        const s = connectFn(this.opts.url ?? '/', {
            path: this.opts.path,
            auth: { proto: TREE_PROTOCOL },
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: Infinity,
        });
        s.on('connect', () => {
            this.pending.clear();
            this.opts.onConnected?.(true);
            if (this.refs.size > 0) this.sendSub([...this.refs.keys()]);
        });
        s.on('disconnect', () => this.opts.onConnected?.(false));
        // A server on another protocol refuses the handshake before any hello.
        s.on('connect_error', (err: Error) => {
            const proto = requiredProtocol(err.message);
            if (proto !== null) this.reloadOnce(`proto-${proto}`);
        });
        s.on(TREE_EVENTS.hello, (h: TreeHello) => this.onHello(h));
        s.on(TREE_EVENTS.frame, (frame: TreeFrame) => this.onFrame(frame));
        s.on(TREE_EVENTS.renamed, (r: TreeRenamed) => this.onRenamed(r));
        this.socket = s;
    }

    disconnect(): void {
        this.socket?.removeAllListeners();
        this.socket?.disconnect();
        this.socket = null;
    }

    /** Subscribe; the returned function unsubscribes (once). */
    subscribe(patterns: string[]): () => void {
        const fresh: string[] = [];
        for (const p of patterns) {
            const n = (this.refs.get(p) ?? 0) + 1;
            this.refs.set(p, n);
            if (n === 1) fresh.push(p);
        }
        if (fresh.length > 0 && this.connected) this.sendSub(fresh);
        let done = false;
        return () => {
            if (done) return;
            done = true;
            const gone: string[] = [];
            for (const original of patterns) {
                const p = this.resolve(original);
                const n = (this.refs.get(p) ?? 1) - 1;
                if (n <= 0) {
                    this.refs.delete(p);
                    gone.push(p);
                } else this.refs.set(p, n);
            }
            if (gone.length === 0) return;
            if (this.connected) this.socket!.emit(TREE_EVENTS.unsub, { patterns: gone }, () => {});
            this.opts.onDropped?.(gone, [...this.refs.keys()]);
        };
    }

    patterns(): string[] {
        return [...this.refs.keys()];
    }

    private resolve(pattern: string): string {
        let p = pattern;
        for (let hops = 0; this.aliases.has(p) && hops < 16; hops++) p = this.aliases.get(p)!;
        return p;
    }

    write(ops: PatchOp[]): Promise<WriteResult> {
        const id = ++this.writeSeq;
        const at = Date.now();
        for (const op of ops) if (op.op === 'replace') this.pending.set(op.path, { id, at });
        return this.request<WriteResult>(TREE_EVENTS.write, { id, ops }, 20_000);
    }

    call<T = unknown>(path: string, method: string, args?: unknown, timeoutMs = 10_000): Promise<T> {
        return this.request<T>(TREE_EVENTS.call, { path, method, args }, timeoutMs);
    }

    private request<T>(event: string, payload: unknown, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const s = this.socket;
            if (!s?.connected) {
                reject(new Error('Not connected'));
                return;
            }
            const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
            s.emit(event, payload, (ack: TreeAck<T>) => {
                clearTimeout(timer);
                if (ack?.ok) resolve(ack.data);
                else reject(new TreeRequestError(ack?.error ?? 'Malformed reply', ack?.code));
            });
        });
    }

    private sendSub(patterns: string[]): void {
        this.socket?.emit(TREE_EVENTS.sub, { patterns }, (ack: TreeAck<{ ops: TreeOp[] }>) => {
            if (ack?.ok) {
                this.opts.onOps(ack.data.ops, { snapshot: true });
                this.opts.onSubscribed?.(patterns);
            } else console.warn('[tree] subscribe failed', patterns, ack);
        });
    }

    private onHello(h: TreeHello): void {
        if (this.build === null) this.build = h.build;
        else if (h.build !== this.build) this.reloadOnce(`build-${h.build}`);
    }

    /** Reload at most once per server version, so a mismatch cannot loop. */
    private reloadOnce(key: string): void {
        try {
            if (sessionStorage.getItem('mr-tree-reload') === key) return;
            sessionStorage.setItem('mr-tree-reload', key);
        } catch {
            /* storage unavailable — reload anyway */
        }
        (this.opts.reload ?? (() => location.reload()))();
    }

    private onFrame(frame: TreeFrame): void {
        const now = Date.now();
        const out: TreeOp[] = [];
        for (const op of frame.ops) {
            let pend = this.pending.get(op.path);
            if (pend && now - pend.at > PENDING_MAX_MS) {
                this.pending.delete(op.path);
                pend = undefined;
            }
            if (op.w !== undefined) {
                if (pend && op.w < pend.id) continue;
                if (pend) this.pending.delete(op.path);
                out.push(op);
            } else if (pend && op.op === 'replace') {
                continue;
            } else {
                out.push(op);
            }
        }
        if (out.length > 0) this.opts.onOps(out, { snapshot: false });
    }

    private onRenamed(r: TreeRenamed): void {
        const next = new Map<string, number>();
        for (const [p, n] of this.refs) {
            const moved = p === r.from || p.startsWith(`${r.from}/`) ? r.to + p.slice(r.from.length) : p;
            if (moved !== p) this.aliases.set(p, moved);
            next.set(moved, n);
        }
        this.refs = next;
        this.opts.onRenamed?.(r);
    }
}

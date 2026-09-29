import {
    TREE_EVENTS,
    WILDCARD,
    covers,
    isPrefix,
    joinPath,
    parsePattern,
    projectOp,
    splitPath,
    type PatchOp,
    type TreeOp,
} from '@media-router/shared-types';
import { TopicIndex } from './TopicIndex.js';
import { SocketOutbox } from './SocketOutbox.js';
import type { TreeSocket, TreeSource } from './types.js';

export interface PublishOptions {
    /** Socket that wrote the op; it gets the op back tagged with `writeId`. */
    origin?: string;
    writeId?: number;
}

/** Concrete paths a pattern names, expanding each '+' through the source. */
function expand(source: TreeSource, pattern: readonly string[]): string[][] {
    let paths: string[][] = [[]];
    for (const seg of pattern) {
        const next: string[][] = [];
        for (const p of paths) {
            if (seg === WILDCARD) for (const key of source.keys(p)) next.push([...p, key]);
            else next.push([...p, seg]);
        }
        paths = next;
    }
    return paths;
}

/** Patterns no other pattern in the list already delivers (snapshot dedupe). */
function withoutCovered(patterns: string[][]): string[][] {
    return patterns.filter(
        (p, i) => !patterns.some((q, j) => j !== i && covers(q, p) && (q.length < p.length || j < i)),
    );
}

/**
 * Routes tree deltas to subscribed sockets (ADR-0024). Holds no data: a
 * snapshot is read from the `TreeSource`, every change arrives via `publish`.
 */
export class TopicBus {
    private index = new TopicIndex();
    private outboxes = new Map<string, { socket: TreeSocket; outbox: SocketOutbox }>();

    constructor(
        private readonly source: TreeSource,
        private readonly flushMs = 50,
    ) {}

    attach(socket: TreeSocket): void {
        this.outboxes.set(socket.id, { socket, outbox: new SocketOutbox(socket, this.flushMs) });
    }

    has(socketId: string): boolean {
        return this.outboxes.has(socketId);
    }

    detach(socketId: string): void {
        this.outboxes.get(socketId)?.outbox.close();
        this.outboxes.delete(socketId);
        this.index.removeSubscriber(socketId);
    }

    /** Add patterns; returns the snapshot as `add` ops. Queued deltas go out first. */
    subscribe(socketId: string, patterns: string[]): PatchOp[] {
        this.outboxes.get(socketId)?.outbox.flushNow();
        const parsed = patterns.map(parsePattern);
        for (const pattern of parsed) this.index.add(socketId, pattern);
        const ops: PatchOp[] = [];
        for (const pattern of withoutCovered(parsed)) {
            for (const path of expand(this.source, pattern)) {
                const value = this.source.get(path);
                if (value !== undefined) ops.push({ op: 'add', path: joinPath(path), value });
            }
        }
        return ops;
    }

    unsubscribe(socketId: string, patterns: string[]): void {
        for (const p of patterns) this.index.remove(socketId, parsePattern(p));
    }

    patternsOf(socketId: string): string[][] {
        return this.index.patternsOf(socketId);
    }

    /** Deliver ops to every socket whose patterns they touch. */
    publish(ops: PatchOp[], opts: PublishOptions = {}): void {
        const echoTo = opts.writeId !== undefined ? opts.origin : undefined;
        for (const op of ops) {
            const path = splitPath(op.path);
            const hits = this.index.match(path);
            for (const [socketId, patterns] of hits) {
                const shaped = projectOp(op, path, patterns);
                if (!shaped) continue;
                this.push(socketId, socketId === echoTo ? { ...shaped, w: opts.writeId } : shaped);
            }
            // A writer always hears back, subscribed or not, so it can settle.
            if (echoTo && !hits.has(echoTo)) this.push(echoTo, { ...op, w: opts.writeId });
        }
    }

    /** Send a writer the stored value at `path` — how a rejected op snaps back. */
    echo(socketId: string, path: string, writeId: number): void {
        const value = this.source.get(splitPath(path));
        this.push(socketId, value === undefined ? { op: 'remove', path, w: writeId } : { op: 'replace', path, value, w: writeId });
    }

    /** Re-key subscriptions under `from` to `to` and tell those sockets. */
    renamePrefix(from: string[], to: string[]): void {
        for (const [socketId, { socket }] of this.outboxes) {
            let moved = false;
            for (const pattern of this.index.patternsOf(socketId)) {
                if (!isPrefix(from, pattern)) continue;
                this.index.remove(socketId, pattern);
                this.index.add(socketId, [...to, ...pattern.slice(from.length)]);
                moved = true;
            }
            if (moved) socket.emit(TREE_EVENTS.renamed, { from: joinPath(from), to: joinPath(to) });
        }
    }

    private push(socketId: string, op: TreeOp): void {
        this.outboxes.get(socketId)?.outbox.push(op);
    }
}

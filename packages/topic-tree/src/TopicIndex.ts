import { WILDCARD, joinPath } from '@media-router/shared-types';

class Node {
    children = new Map<string, Node>();
    /** subscriber → patterns ending at this node */
    terminals = new Map<string, Set<string>>();
}

/**
 * Subscription patterns of every subscriber in a segment trie, so a write
 * finds its subscribers in one walk along its path instead of a scan.
 */
export class TopicIndex {
    private root = new Node();
    private bySubscriber = new Map<string, Map<string, string[]>>();

    /** False when the subscriber already held the pattern. */
    add(subscriber: string, pattern: string[]): boolean {
        const key = joinPath(pattern);
        let own = this.bySubscriber.get(subscriber);
        if (!own) this.bySubscriber.set(subscriber, (own = new Map()));
        if (own.has(key)) return false;
        own.set(key, pattern);
        let node = this.root;
        for (const seg of pattern) {
            let next = node.children.get(seg);
            if (!next) node.children.set(seg, (next = new Node()));
            node = next;
        }
        let set = node.terminals.get(subscriber);
        if (!set) node.terminals.set(subscriber, (set = new Set()));
        set.add(key);
        return true;
    }

    remove(subscriber: string, pattern: string[]): boolean {
        const key = joinPath(pattern);
        const own = this.bySubscriber.get(subscriber);
        if (!own?.delete(key)) return false;
        if (own.size === 0) this.bySubscriber.delete(subscriber);
        this.prune(this.root, pattern, 0, subscriber, key);
        return true;
    }

    removeSubscriber(subscriber: string): void {
        for (const pattern of this.patternsOf(subscriber)) this.remove(subscriber, pattern);
    }

    patternsOf(subscriber: string): string[][] {
        return [...(this.bySubscriber.get(subscriber)?.values() ?? [])];
    }

    /** Subscribers whose patterns overlap a write at `path`, with those patterns. */
    match(path: readonly string[]): Map<string, string[][]> {
        const hits = new Map<string, string[][]>();
        this.walk(this.root, path, 0, hits);
        return hits;
    }

    private walk(node: Node, path: readonly string[], depth: number, hits: Map<string, string[][]>): void {
        this.collect(node, hits);
        if (depth === path.length) {
            for (const child of node.children.values()) this.collectAll(child, hits);
            return;
        }
        const exact = node.children.get(path[depth]);
        if (exact) this.walk(exact, path, depth + 1, hits);
        const wild = path[depth] === WILDCARD ? undefined : node.children.get(WILDCARD);
        if (wild) this.walk(wild, path, depth + 1, hits);
    }

    private collect(node: Node, hits: Map<string, string[][]>): void {
        for (const [subscriber, keys] of node.terminals) {
            const own = this.bySubscriber.get(subscriber);
            let list = hits.get(subscriber);
            if (!list) hits.set(subscriber, (list = []));
            for (const key of keys) list.push(own!.get(key)!);
        }
    }

    private collectAll(node: Node, hits: Map<string, string[][]>): void {
        this.collect(node, hits);
        for (const child of node.children.values()) this.collectAll(child, hits);
    }

    private prune(node: Node, pattern: string[], depth: number, subscriber: string, key: string): boolean {
        if (depth === pattern.length) {
            const set = node.terminals.get(subscriber);
            set?.delete(key);
            if (set?.size === 0) node.terminals.delete(subscriber);
        } else {
            const child = node.children.get(pattern[depth]);
            if (child && this.prune(child, pattern, depth + 1, subscriber, key)) {
                node.children.delete(pattern[depth]);
            }
        }
        return node.terminals.size === 0 && node.children.size === 0;
    }
}

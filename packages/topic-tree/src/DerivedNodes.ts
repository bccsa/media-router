import { diffValues, isPrefix, joinPath, splitPath } from '@media-router/shared-types';
import type { TopicBus } from './TopicBus.js';

/**
 * Tree nodes computed from other data — the `/meta` descriptors (ADR-0024).
 * A node is recomputed when its inputs change and published as a diff, and
 * only while a socket subscribes to it by name: `/` and `+` do not pull a
 * derived branch.
 */
export class DerivedNodes {
    /** Last published value per node path, while subscribed. */
    private last = new Map<string, unknown>();

    constructor(
        private readonly bus: TopicBus,
        private readonly compute: (path: readonly string[]) => unknown,
    ) {}

    /** The inputs of the node at `path` changed. */
    refresh(path: string[]): void {
        const key = joinPath(path);
        if (!this.bus.namedBy(path)) {
            this.last.delete(key);
            return;
        }
        const prev = this.last.get(key);
        const next = this.compute(path);
        if (next === undefined) {
            this.last.delete(key);
            this.bus.publish([{ op: 'remove', path: key }], NAMED);
            return;
        }
        this.last.set(key, next);
        // Without a previous value (first change since subscribe) the node goes whole.
        this.bus.publish(prev === undefined ? [{ op: 'replace', path: key, value: next }] : diffValues(prev, next, path), NAMED);
    }

    /** Refresh the children of `prefix`: these ids, and any tracked child that is gone. */
    refreshChildren(prefix: string[], ids: Iterable<string>): void {
        const seen = new Set(ids);
        for (const id of seen) this.refresh([...prefix, id]);
        for (const key of [...this.last.keys()]) {
            const path = splitPath(key);
            if (path.length === prefix.length + 1 && isPrefix(prefix, path) && !seen.has(path[prefix.length])) this.refresh(path);
        }
    }

    /** Drop tracked nodes under `prefix` (a renamed or deleted engine). */
    forget(prefix: string[]): void {
        for (const key of [...this.last.keys()]) if (isPrefix(prefix, splitPath(key))) this.last.delete(key);
    }
}

const NAMED = { named: true };

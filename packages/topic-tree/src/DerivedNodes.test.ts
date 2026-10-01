import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TopicBus } from './TopicBus.js';
import { DerivedNodes } from './DerivedNodes.js';
import { fakeSocket, objectSource } from './testing.js';

function setup() {
    const data: Record<string, any> = { m1: { max: 150 }, m2: { max: 10 } };
    const bus = new TopicBus(objectSource({ meta: data }), 10);
    const nodes = new DerivedNodes(bus, (p) => data[p[1]] && { ...data[p[1]] });
    const sock = (id: string, patterns: string[]) => {
        const s = fakeSocket(id);
        bus.attach(s);
        bus.subscribe(id, patterns);
        return s;
    };
    const seen = new Map<string, number>();
    /** Ops sent to `s` since the last look. */
    const ops = (s: ReturnType<typeof fakeSocket>) => {
        vi.advanceTimersByTime(10);
        const frames = s.frames();
        const from = seen.get(s.id) ?? 0;
        seen.set(s.id, frames.length);
        return frames.slice(from).flat();
    };
    return { data, bus, nodes, sock, ops };
}

describe('DerivedNodes', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('publishes only to sockets that name the branch — not to `/` or `+`', () => {
        const { data, nodes, sock, ops } = setup();
        const root = sock('root', ['/']);
        const wild = sock('wild', ['/+/m1']);
        data.m1.max = 200;
        nodes.refresh(['meta', 'm1']);
        expect(ops(root)).toEqual([]);
        expect(ops(wild)).toEqual([]);
        const named = sock('named', ['/meta/m1/max']);
        data.m1.max = 300;
        nodes.refresh(['meta', 'm1']);
        // First change since subscribe: the whole node, pruned to the socket's pattern.
        expect(ops(named)).toEqual([{ op: 'replace', path: '/meta/m1', value: { max: 300 } }]);
        // A named subscriber exists now; `/` and `+` still get nothing.
        expect(ops(root)).toEqual([]);
        expect(ops(wild)).toEqual([]);
    });

    it('whole node on the first change, then diffs; remove when the node goes', () => {
        const { data, nodes, sock, ops } = setup();
        const s = sock('s', ['/meta']);
        data.m1.max = 200;
        nodes.refresh(['meta', 'm1']);
        expect(ops(s)).toEqual([{ op: 'replace', path: '/meta/m1', value: { max: 200 } }]);
        data.m1.max = 250;
        nodes.refresh(['meta', 'm1']);
        expect(ops(s)).toEqual([{ op: 'replace', path: '/meta/m1/max', value: 250 }]);
        delete data.m1;
        nodes.refresh(['meta', 'm1']);
        expect(ops(s)).toEqual([{ op: 'remove', path: '/meta/m1' }]);
    });

    it('refreshChildren also covers a tracked child that disappeared', () => {
        const { data, nodes, sock, ops } = setup();
        const s = sock('s', ['/meta']);
        nodes.refreshChildren(['meta'], ['m1', 'm2']);
        ops(s);
        delete data.m2;
        nodes.refreshChildren(['meta'], ['m1']);
        expect(ops(s)).toEqual([{ op: 'remove', path: '/meta/m2' }]);
    });
});

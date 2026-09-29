import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TopicBus } from './TopicBus.js';
import { fakeSocket, objectSource } from './testing.js';

function world() {
    return {
        engines: {
            e1: { info: { online: true }, modules: { m1: { health: 'ok', settings: { volume: 80 } } } },
            e2: { info: { online: false }, modules: {} },
        },
    };
}

describe('TopicBus', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('answers a subscription with a snapshot, expanding wildcards', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        bus.attach(a);
        expect(bus.subscribe('a', ['/engines/+/info'])).toEqual([
            { op: 'add', path: '/engines/e1/info', value: { online: true } },
            { op: 'add', path: '/engines/e2/info', value: { online: false } },
        ]);
    });

    it('skips snapshot parts another pattern in the request already covers', () => {
        const bus = new TopicBus(objectSource(world()));
        bus.attach(fakeSocket('a'));
        const ops = bus.subscribe('a', ['/engines/e1/info', '/engines/e1']);
        expect(ops.map((o) => o.path)).toEqual(['/engines/e1']);
    });

    it('a `+` pattern overlapping a subtree does not repeat its values in the snapshot', () => {
        const bus = new TopicBus(objectSource(world()));
        bus.attach(fakeSocket('s'));
        const paths = bus.subscribe('s', ['/engines/+/info', '/engines/e1']).map((o) => o.path);
        expect(paths.sort()).toEqual(['/engines/e1', '/engines/e2/info']);
    });

    it('delivers only to overlapping subscribers, pruning ancestor writes', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        const b = fakeSocket('b');
        bus.attach(a);
        bus.attach(b);
        bus.subscribe('a', ['/engines/e1']);
        bus.subscribe('b', ['/engines/+/modules/+/health']);
        bus.publish([
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 60 },
            { op: 'replace', path: '/engines/e1/modules', value: { m1: { health: 'warning', settings: {} } } },
        ]);
        vi.advanceTimersByTime(50);
        expect(a.frames()[0]).toHaveLength(2);
        expect(b.frames()[0]).toEqual([
            { op: 'replace', path: '/engines/e1/modules', value: { m1: { health: 'warning' } } },
        ]);
    });

    it('tags the writer copy with its write id and echoes even when unsubscribed', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        const b = fakeSocket('b');
        bus.attach(a);
        bus.attach(b);
        bus.subscribe('b', ['/engines/e1']);
        const op = { op: 'replace' as const, path: '/engines/e1/modules/m1/settings/volume', value: 60 };
        bus.publish([op], { origin: 'a', writeId: 3 });
        vi.advanceTimersByTime(50);
        expect(a.frames()[0]).toEqual([{ ...op, w: 3 }]);
        expect(b.frames()[0]).toEqual([op]);
    });

    it('echo sends the stored value back', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        bus.attach(a);
        bus.echo('a', '/engines/e1/modules/m1/settings/volume', 9);
        bus.echo('a', '/engines/e1/modules/gone', 9);
        vi.advanceTimersByTime(50);
        expect(a.frames()[0]).toEqual([
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 80, w: 9 },
            { op: 'remove', path: '/engines/e1/modules/gone', w: 9 },
        ]);
    });

    it('flushes queued deltas before a snapshot', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        bus.attach(a);
        bus.subscribe('a', ['/engines/e1/info']);
        bus.publish([{ op: 'replace', path: '/engines/e1/info/online', value: false }]);
        bus.subscribe('a', ['/engines/e2']);
        expect(a.frames()).toHaveLength(1);
    });

    it('renames subscriptions under a prefix and tells the socket', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        bus.attach(a);
        bus.subscribe('a', ['/engines/e1/info']);
        bus.renamePrefix(['engines', 'e1'], ['engines', 'e9']);
        expect(bus.patternsOf('a')).toEqual([['engines', 'e9', 'info']]);
        expect(a.emitted).toContainEqual(['tree:renamed', { from: '/engines/e1', to: '/engines/e9' }]);
    });

    it('detach stops delivery', () => {
        const bus = new TopicBus(objectSource(world()));
        const a = fakeSocket('a');
        bus.attach(a);
        bus.subscribe('a', ['/engines']);
        bus.detach('a');
        bus.publish([{ op: 'replace', path: '/engines/e1/info/online', value: false }]);
        vi.advanceTimersByTime(50);
        expect(a.frames()).toHaveLength(0);
    });
});

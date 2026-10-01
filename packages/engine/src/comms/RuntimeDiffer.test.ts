import { describe, it, expect, vi, afterEach } from 'vitest';
import { RuntimeDiffer } from './RuntimeDiffer.js';
import { StatePatchBatcher } from './StatePatchBatcher.js';

const state = (over: Record<string, unknown> = {}) =>
    ({ running: true, ready: true, health: 'ok', pendingRestart: false, ...over }) as any;

describe('RuntimeDiffer', () => {
    it('emits every field of a first state as replace ops, VU left out', () => {
        const d = new RuntimeDiffer();
        const ops = d.update('m1', state({ vuData: [-3] }));
        expect(ops).toContainEqual({ op: 'replace', path: '/modules/m1/health', value: 'ok' });
        expect(ops.some((o) => o.path.endsWith('vuData'))).toBe(false);
    });

    it('emits only what changed after that', () => {
        const d = new RuntimeDiffer();
        d.update('m1', state({ statusData: { stats: { bitrate: 1 } } }));
        expect(d.update('m1', state({ statusData: { stats: { bitrate: 2 } } }))).toEqual([
            { op: 'replace', path: '/modules/m1/statusData/stats/bitrate', value: 2 },
        ]);
        expect(d.update('m1', state({ statusData: { stats: { bitrate: 2 } } }))).toEqual([]);
    });

    it('is not fooled by a caller mutating the state it passed in', () => {
        const d = new RuntimeDiffer();
        const s = state({ statusData: { stats: { bitrate: 1 } } });
        d.update('m1', s);
        s.statusData.stats.bitrate = 5;
        expect(d.update('m1', s)).toEqual([{ op: 'replace', path: '/modules/m1/statusData/stats/bitrate', value: 5 }]);
    });

    it('forgets a dropped module', () => {
        const d = new RuntimeDiffer();
        d.update('m1', state());
        d.drop('m1');
        expect(d.snapshot()).toEqual({});
    });
});

describe('StatePatchBatcher', () => {
    afterEach(() => vi.useRealTimers());

    it('sends one numbered message per window, latest value per path', () => {
        vi.useFakeTimers();
        const send = vi.fn();
        const b = new StatePatchBatcher(send, 250);
        b.push([{ op: 'replace', path: '/modules/m1/health', value: 'ok' }]);
        b.push([{ op: 'replace', path: '/modules/m1/health', value: 'warning' }, { op: 'replace', path: '/modules/m2/running', value: true }]);
        vi.advanceTimersByTime(250);
        expect(send).toHaveBeenCalledWith({
            seq: 1,
            ops: [{ op: 'replace', path: '/modules/m1/health', value: 'warning' }, { op: 'replace', path: '/modules/m2/running', value: true }],
        });
        b.push([{ op: 'remove', path: '/modules/m1/error' }]);
        vi.advanceTimersByTime(250);
        expect(send.mock.calls[1][0].seq).toBe(2);
    });

    it('reset drops the queue and restarts numbering', () => {
        vi.useFakeTimers();
        const send = vi.fn();
        const b = new StatePatchBatcher(send, 250);
        b.push([{ op: 'replace', path: '/a', value: 1 }]);
        b.reset();
        vi.advanceTimersByTime(500);
        expect(send).not.toHaveBeenCalled();
        b.push([{ op: 'replace', path: '/a', value: 2 }]);
        vi.advanceTimersByTime(250);
        expect(send.mock.calls[0][0].seq).toBe(1);
    });
});

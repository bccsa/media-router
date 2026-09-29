import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManagerStateSync } from './ManagerStateSync.js';

const state = (health: string) => ({ running: true, ready: true, health, pendingRestart: false }) as any;

function setup(states: Record<string, unknown> = { m1: state('ok') }) {
    const link = { send: vi.fn(), sendState: vi.fn() };
    const tree = { moduleOps: vi.fn() } as any;
    const sync = new ManagerStateSync(link, () => states as any, tree);
    const patches = () => link.send.mock.calls.filter(([t]) => t === 'statePatch').map(([, m]) => m);
    return { link, tree, sync, patches };
}

describe('ManagerStateSync', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('feeds the router tree leaf ops and the manager batched whole states', () => {
        const { link, tree, sync } = setup();
        sync.stateChange('m1', state('ok'));
        sync.stateChange('m1', state('warning'));
        expect(tree.moduleOps).toHaveBeenLastCalledWith([{ op: 'replace', path: '/modules/m1/health', value: 'warning' }]);
        vi.advanceTimersByTime(250);
        expect(link.sendState).toHaveBeenCalledTimes(1);
        expect(link.sendState.mock.calls[0][0].m1.health).toBe('warning');
    });

    it('switches to numbered patches after hello, with a baseline snapshot', () => {
        const { link, sync, patches } = setup();
        sync.hello({ features: ['other'] });
        expect(link.sendState).not.toHaveBeenCalled();
        sync.hello({ features: ['statePatch'] });
        expect(link.sendState).toHaveBeenCalledTimes(1);
        sync.stateChange('m1', state('ok'));
        sync.stateChange('m1', state('error'));
        vi.advanceTimersByTime(250);
        expect(patches().map((m) => m.seq)).toEqual([1]);
        expect(link.sendState).toHaveBeenCalledTimes(1);
    });

    it('heartbeat: a snapshot every beat in whole-state mode, every 6th in patch mode', () => {
        const { link, sync } = setup();
        sync.connected();
        sync.heartbeat();
        expect(link.sendState).toHaveBeenCalledTimes(2);
        sync.hello({ features: ['statePatch'] });
        link.sendState.mockClear();
        sync.connected();
        link.sendState.mockClear();
        for (let i = 0; i < 5; i++) sync.heartbeat();
        expect(link.sendState).not.toHaveBeenCalled();
        sync.heartbeat();
        expect(link.sendState).toHaveBeenCalledTimes(1);
    });

    it('a snapshot restarts the patch count; disconnect falls back to whole states', () => {
        const { link, sync, patches } = setup();
        sync.hello({ features: ['statePatch'] });
        sync.stateChange('m1', state('warning'));
        vi.advanceTimersByTime(250);
        sync.snapshot();
        sync.stateChange('m1', state('error'));
        vi.advanceTimersByTime(250);
        expect(patches().map((m) => m.seq)).toEqual([1, 1]);
        sync.disconnected();
        link.sendState.mockClear();
        sync.stateChange('m1', state('ok'));
        vi.advanceTimersByTime(250);
        expect(link.sendState).toHaveBeenCalledTimes(1);
    });

    it('a dropped module is forgotten by the diff and the batch', () => {
        const { link, sync } = setup({});
        sync.stateChange('m1', state('ok'));
        sync.drop('m1');
        vi.advanceTimersByTime(250);
        expect(link.sendState.mock.calls.some(([batch]) => 'm1' in batch)).toBe(false);
    });
});

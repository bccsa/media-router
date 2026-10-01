import { describe, it, expect, vi } from 'vitest';
import { ManagerScripts } from './ManagerScripts.js';

const caller = { socketId: 's1' } as any;
const button = (steps: unknown[]) => ({
    name: 'D', cols: 24, rows: 14, scroll: false, zoom: false, locked: false, theme: 'dark',
    widgets: [{ id: 'b1', type: 'button', x: 0, y: 0, w: 3, h: 2, script: { steps } }],
});

function setup(dashboard: unknown, profileDashboards: Record<string, unknown> = {}) {
    const published: unknown[] = [];
    const writes = { handle: vi.fn(async (_c: unknown, ops: Array<{ path: string; value: unknown }>) => ({ rejected: ops[0].value === 999 ? [{ index: 0, path: ops[0].path, reason: 'above 150' }] : [] })) };
    const calls = { handle: vi.fn(() => ({})) };
    const configStore = {
        getDashboard: vi.fn(() => dashboard),
        getEngine: vi.fn(() => ({ active_profile: 'p' })),
        getProfile: vi.fn(() => ({ dashboards: profileDashboards })),
    };
    const tree = { get: vi.fn((p: string[]) => (p.join('/') === 'engines/e1/modules/m1/settings/volume' ? 100 : undefined)) };
    const s = new ManagerScripts({ tree: tree as any, bus: { publish: (ops: unknown[]) => published.push(...ops) }, configStore: configStore as any });
    s.attach(writes as any, calls as any);
    return { s, writes, calls, published };
}

describe('button scripts on the manager (ADR-0027)', () => {
    it("a manager dashboard's steps go through the browser writes and calls, absolute paths", async () => {
        const { s, writes, calls } = setup(button([
            { do: 'write', path: '/engines/e1/modules/m1/settings/volume', value: { lit: 40 } },
            { do: 'call', path: '/engines/e2', method: 'reset' },
        ]));
        expect(s.call(caller, '/dashboards/d1', 'run', { widget: 'b1' })).toEqual({});
        await vi.waitFor(() => expect(s.runs.state('_/d1/b1')?.state).toBe('done'));
        expect(writes.handle).toHaveBeenCalledWith(caller, [{ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 40 }], 0);
        expect(calls.handle).toHaveBeenCalledWith(caller, '/engines/e2', 'reset', undefined);
    });

    it("a router dashboard through the manager: its paths are the router's, prefixed", async () => {
        const { s, writes, calls, published } = setup(undefined, {
            d9: button([
                { do: 'write', path: '/modules/m1/settings/volume', value: { op: '-', a: { read: '/modules/m1/settings/volume' }, b: { lit: 10 } } },
                { do: 'call', path: '/', method: 'reboot' },
            ]),
        });
        s.call(caller, '/engines/e1/dashboards/d9', 'run', { widget: 'b1' });
        await vi.waitFor(() => expect(s.runs.state('e1/d9/b1')?.state).toBe('done'));
        expect(writes.handle.mock.calls[0][1]).toEqual([{ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 90 }]);
        expect(calls.handle).toHaveBeenCalledWith(caller, '/engines/e1', 'reboot', undefined);
        expect(published).toContainEqual(expect.objectContaining({ path: '/runs/e1/d9/b1' }));
    });

    it('a refused write fails the run; other calls pass through untouched', async () => {
        const { s } = setup(button([{ do: 'write', path: '/engines/e1/modules/m1/settings/volume', value: { lit: 999 } }]));
        s.call(caller, '/dashboards/d1', 'run', { widget: 'b1' });
        await vi.waitFor(() => expect(s.runs.state('_/d1/b1')).toMatchObject({ state: 'failed', error: expect.stringContaining('above 150') }));
        expect(s.call(caller, '/dashboards/d1', 'save', {})).toBeUndefined();
        expect(s.call(caller, '/engines/e1', 'run', {})).toBeUndefined();
    });
});

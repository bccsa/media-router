import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { newDashboard } from '@media-router/shared-types';
import { setup } from './testing/managerTreeFixture.js';
import { failureOf } from '@media-router/topic-tree/testing';

const AT = '/engines/e1/dashboards';
const fader = (x = 0) => ({ id: `w${x}`, type: 'fader', x, y: 0, w: 2, h: 6, bind: '/modules/m1/settings/volume' });
const stage = (widgets = [fader()]) => ({ ...newDashboard('Stage'), widgets });

describe('router dashboards (ADR-0026)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('save stores a new dashboard in the active profile, patches the router and publishes it', () => {
        const { calls, engineManager, stored, track } = setup();
        const t = track('a', [AT]);
        const { id, rev } = calls.handle({ socketId: 'x' }, AT, 'save', { dashboard: stage() }) as { id: string; rev: number };
        expect(id).toMatch(/^dsh_/);
        expect(rev).toBe(1);
        expect(stored().dashboards[id]).toMatchObject({ name: 'Stage', rev: 1, widgets: [fader()] });
        expect(engineManager.sendToEngine).toHaveBeenCalledWith(
            'e1', 'patch', { ops: [{ op: 'add', path: `/dashboards/${id}`, value: expect.objectContaining({ name: 'Stage', rev: 1 }) }] }, { guaranteeDelivery: true },
        );
        expect(t.sync().engines.e1.dashboards[id].name).toBe('Stage');
    });

    it('a save based on an older revision is a conflict unless forced', () => {
        const { calls, stored } = setup();
        const { id } = calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() }) as { id: string };
        calls.handle({ socketId: 'a' }, AT, 'save', { id, baseRev: 1, dashboard: stage([fader(0), fader(2)]) });
        expect(failureOf(() => calls.handle({ socketId: 'b' }, AT, 'save', { id, baseRev: 1, dashboard: stage([]) })).code).toBe('conflict');
        expect(calls.handle({ socketId: 'b' }, AT, 'save', { id, baseRev: 1, force: true, dashboard: stage([]) })).toEqual({ id, rev: 3 });
        expect(stored().dashboards[id].widgets).toEqual([]);
    });

    it('names are unique per profile and dashboards are checked', () => {
        const { calls } = setup();
        calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() });
        expect(() => calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() })).toThrow('A dashboard named "Stage" already exists');
        const outside = { ...newDashboard('Wide'), widgets: [fader(23)] };
        expect(() => calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: outside })).toThrow('invalid dashboard: widgets 0 outside the grid');
        expect(() => calls.handle({ socketId: 'a' }, AT, 'save', { id: 'nope', dashboard: stage() })).toThrow('Dashboard not found');
    });

    it('dashboards are not writable through writes, only through calls', async () => {
        const { writes } = setup();
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'add', path: `${AT}/d1`, value: stage() }], 1);
        expect(res.rejected[0].reason).toBe('not writable');
    });

    it('delete removes it from the profile and the router', () => {
        const { calls, engineManager, stored } = setup();
        const { id } = calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() }) as { id: string };
        engineManager.sendToEngine.mockClear();
        calls.handle({ socketId: 'a' }, `${AT}/${id}`, 'delete', {});
        expect(stored().dashboards[id]).toBeUndefined();
        expect(engineManager.sendToEngine).toHaveBeenCalledWith('e1', 'patch', { ops: [{ op: 'remove', path: `/dashboards/${id}` }] }, { guaranteeDelivery: true });
    });

    it('copy to another profile rebinds the mapped modules and only stores it there', () => {
        const { calls, configStore, engineManager } = setup();
        configStore.createProfile('e1', 'spare', { modules: { m7: { pluginId: 'audio-output', settings: {} } } });
        const { id } = calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() }) as { id: string };
        engineManager.sendToEngine.mockClear();
        const { id: copyId } = calls.handle({ socketId: 'a' }, `${AT}/${id}`, 'copy', { toEngine: 'e1', toProfile: 'spare', name: 'Stage B', modules: { m1: 'm7' } }) as { id: string };
        const copy = (configStore.getProfile('e1', 'spare') as any).dashboards[copyId];
        expect(copy).toMatchObject({ name: 'Stage B', rev: 1, widgets: [{ bind: '/modules/m7/settings/volume' }] });
        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        expect(() => calls.handle({ socketId: 'a' }, `${AT}/${id}`, 'copy', { toEngine: 'e1', toProfile: 'spare', name: 'Stage B', modules: {} })).toThrow(/already exists there/);
    });

    it('a rollback brings back a deleted dashboard', () => {
        const { calls, stored } = setup();
        const { id } = calls.handle({ socketId: 'a' }, AT, 'save', { dashboard: stage() }) as { id: string };
        vi.advanceTimersByTime(11 * 60 * 1000); // history keeps one version per 10 min
        calls.handle({ socketId: 'a' }, `${AT}/${id}`, 'delete', {});
        const versions = calls.handle({ socketId: 'a' }, '/engines/e1/profiles/default', 'history', {}) as Array<{ id: number; config: string }>;
        const withIt = versions.find((v) => JSON.parse(v.config).dashboards?.[id])!;
        calls.handle({ socketId: 'a' }, '/engines/e1/profiles/default', 'rollback', { versionId: withIt.id });
        expect(stored().dashboards[id].name).toBe('Stage');
    });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { newDashboard } from '@media-router/shared-types';
import { setup } from './testing/managerTreeFixture.js';
import { failureOf } from '@media-router/topic-tree/testing';

const board = (name = 'Fleet', bind = '/engines/e1/modules/m1/settings/volume') => ({
    ...newDashboard(name),
    widgets: [{ id: 'w1', type: 'fader', x: 0, y: 0, w: 2, h: 6, bind }],
});
const save = (calls: any, raw: unknown) => calls.handle({ socketId: 'x' }, '/dashboards', 'save', raw) as { id: string; rev: number };

describe('manager dashboards (ADR-0026)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('save stores it on the manager and publishes it under /dashboards; the router is not involved', () => {
        const { calls, configStore, engineManager, track } = setup();
        const t = track('a', ['/dashboards']);
        const { id, rev } = save(calls, { dashboard: board() });
        expect(rev).toBe(1);
        expect(configStore.getDashboard(id)).toMatchObject({ name: 'Fleet', rev: 1 });
        expect(t.sync().dashboards[id].widgets[0].bind).toBe('/engines/e1/modules/m1/settings/volume');
        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
    });

    it('saves check the revision and names, like router dashboards', () => {
        const { calls } = setup();
        const { id } = save(calls, { dashboard: board() });
        save(calls, { id, baseRev: 1, dashboard: board() });
        expect(failureOf(() => save(calls, { id, baseRev: 1, dashboard: board() })).code).toBe('conflict');
        expect(() => save(calls, { dashboard: board() })).toThrow('A dashboard named "Fleet" already exists');
    });

    it('duplicate copies it under a new name with a fresh revision', () => {
        const { calls, configStore } = setup();
        const { id } = save(calls, { dashboard: board() });
        save(calls, { id, baseRev: 1, dashboard: board() });
        const { id: copy } = calls.handle({ socketId: 'x' }, `/dashboards/${id}`, 'duplicate', { name: 'Fleet 2' }) as { id: string };
        expect(configStore.getDashboard(copy)).toMatchObject({ name: 'Fleet 2', rev: 1 });
    });

    it('keeps a history like profiles, and rollback restores a version as a new revision', () => {
        const { calls, configStore } = setup();
        const { id } = save(calls, { dashboard: board() });
        vi.advanceTimersByTime(11 * 60 * 1000); // one version per 10 min
        save(calls, { id, baseRev: 1, dashboard: { ...board(), widgets: [] } });
        const versions = calls.handle({ socketId: 'x' }, `/dashboards/${id}`, 'history', {}) as Array<{ id: number; config: string }>;
        expect(versions).toHaveLength(2);
        const first = versions.find((v) => JSON.parse(v.config).widgets.length === 1)!;
        expect(calls.handle({ socketId: 'x' }, `/dashboards/${id}`, 'rollback', { versionId: first.id })).toEqual({ rev: 3 });
        expect(configStore.getDashboard(id)).toMatchObject({ rev: 3, widgets: [{ id: 'w1' }] });
    });

    it('an engine rename moves the dashboards\' paths with it', () => {
        const { calls, configStore } = setup();
        const { id } = save(calls, { dashboard: board() });
        calls.handle({ socketId: 'x' }, '/engines/e1', 'rename', { newEngineId: 'e9' });
        expect(configStore.getDashboard(id)).toMatchObject({ rev: 2, widgets: [{ bind: '/engines/e9/modules/m1/settings/volume' }] });
    });

    it('delete removes it and its history', () => {
        const { calls, configStore } = setup();
        const { id } = save(calls, { dashboard: board() });
        calls.handle({ socketId: 'x' }, `/dashboards/${id}`, 'delete', {});
        expect(configStore.getDashboard(id)).toBeUndefined();
        expect(configStore.getDashboardHistory(id)).toEqual([]);
        expect(() => calls.handle({ socketId: 'x' }, `/dashboards/${id}`, 'history', {})).toThrow('Dashboard not found');
    });
});

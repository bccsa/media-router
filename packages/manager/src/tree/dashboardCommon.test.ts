import { describe, it, expect } from 'vitest';
import { newDashboard, type Dashboard } from '@media-router/shared-types';
import { checkSave, newDashboardId, parseDashboard } from './dashboardCommon.js';
import { Rollback, args } from './callArgs.js';
import { failureOf } from '@media-router/topic-tree/testing';

describe('dashboard call checks', () => {
    const all: Record<string, Dashboard> = { a: { ...newDashboard('Desk'), rev: 3 }, b: newDashboard('Stage') };

    it('a new dashboard gets an id and revision 1; an update the next revision', () => {
        const fresh = checkSave({ dashboard: {} }, all, newDashboard('Booth'));
        expect(fresh).toMatchObject({ rev: 1, exists: false });
        expect(fresh.id).toMatch(/^dsh_/);
        expect(checkSave({ id: 'a', baseRev: 3, dashboard: {} }, all, newDashboard('Desk'))).toEqual({ id: 'a', rev: 4, exists: true });
    });

    it('refuses an unknown id, an older revision (unless forced) and a taken name', () => {
        expect(failureOf(() => checkSave({ id: 'zz', dashboard: {} }, all, newDashboard('X'))).message).toBe('Dashboard not found');
        expect(failureOf(() => checkSave({ id: 'a', baseRev: 2, dashboard: {} }, all, newDashboard('Desk'))).code).toBe('conflict');
        expect(checkSave({ id: 'a', baseRev: 2, force: true, dashboard: {} }, all, newDashboard('Desk')).rev).toBe(4);
        expect(failureOf(() => checkSave({ id: 'a', baseRev: 3, dashboard: {} }, all, newDashboard('Stage'))).message).toMatch(/already exists/);
    });

    it('names the first problem of an invalid dashboard', () => {
        expect(parseDashboard(newDashboard('Desk')).name).toBe('Desk');
        expect(failureOf(() => parseDashboard({ ...newDashboard('Desk'), cols: 0 })).message).toMatch(/^invalid dashboard: cols/);
    });

    it('checks call arguments', () => {
        expect(args(Rollback, { versionId: 2 })).toEqual({ versionId: 2 });
        expect(failureOf(() => args(Rollback, { versionId: -1 })).message).toBe('invalid arguments');
        expect(newDashboardId()).not.toBe(newDashboardId());
    });
});

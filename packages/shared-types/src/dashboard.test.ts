import { describe, it, expect } from 'vitest';
import { DashboardSchema, copyDashboard, dashboardsOf, findDashboard, newDashboard, rebindPath, rebindWidget, widgetPaths, type DashboardWidget } from './dashboard.js';

const fader = (id: string, bind: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({ id, type: 'fader', x: 0, y: 0, w: 2, h: 6, bind, ...extra });

describe('dashboard model', () => {
    it('accepts a new dashboard and a widget inside the grid', () => {
        const d = { ...newDashboard('Stage'), widgets: [fader('w1', '/modules/a/settings/volume', { x: 22, y: 8 })] };
        expect(DashboardSchema.safeParse(d).success).toBe(true);
        expect(d).toMatchObject({ cols: 24, rows: 14, scroll: false, zoom: false, locked: false, theme: 'dark' });
    });

    it('rejects widgets outside the grid and duplicate widget ids', () => {
        const out = { ...newDashboard('S'), widgets: [fader('w1', '/a', { x: 23 })] };
        expect(DashboardSchema.safeParse(out).error?.issues[0].message).toBe('outside the grid');
        const dup = { ...newDashboard('S'), widgets: [fader('w1', '/a'), fader('w1', '/b')] };
        expect(DashboardSchema.safeParse(dup).error?.issues[0].message).toBe('duplicate widget id');
    });

    it('rejects an empty name, a relative path and an unknown action kind', () => {
        expect(DashboardSchema.safeParse(newDashboard('  ')).success).toBe(false);
        expect(DashboardSchema.safeParse({ ...newDashboard('S'), widgets: [fader('w1', 'modules/a')] }).success).toBe(false);
        const bad = { ...newDashboard('S'), widgets: [{ ...fader('w1', '/a'), action: { kind: 'shell', path: '/x' } }] };
        expect(DashboardSchema.safeParse(bad).success).toBe(false);
    });

    it('rebinds a path below a module only', () => {
        expect(rebindPath('/modules/a/settings/volume', '/modules/a', '/modules/b')).toBe('/modules/b/settings/volume');
        expect(rebindPath('/modules/ab/vu', '/modules/a', '/modules/b')).toBe('/modules/ab/vu');
        expect(rebindPath('/info/running', '/modules/a', '/modules/b')).toBe('/info/running');
        const w = rebindWidget({ ...fader('w1', '/modules/a/vu'), action: { kind: 'call', path: '/modules/a', method: 'restart' } }, '/modules/a', '/modules/b');
        expect(w).toMatchObject({ bind: '/modules/b/vu', action: { path: '/modules/b' } });
    });

    it('copies with a module map applied once per path, dropping the revision', () => {
        const d = { ...newDashboard('Stage'), rev: 7, widgets: [fader('w1', '/modules/a/settings/volume'), fader('w2', '/modules/b/vu'), fader('w3', '/modules/c/vu')] };
        const copy = copyDashboard(d, 'Stage 2', { '/modules/a': '/modules/b', '/modules/b': '/modules/c' });
        expect(copy.widgets.map((w) => w.bind)).toEqual(['/modules/b/settings/volume', '/modules/c/vu', '/modules/c/vu']);
        expect(copy).toMatchObject({ name: 'Stage 2' });
        expect(copy.rev).toBeUndefined();
        expect(d.widgets[0].bind).toBe('/modules/a/settings/volume');
    });

    it('a trend holds 1 to 8 values, and they move with their modules', () => {
        const trend = (binds: string[]): DashboardWidget => ({ id: 't', type: 'trend', x: 0, y: 0, w: 6, h: 4, binds });
        const ok = (binds: string[]) => DashboardSchema.safeParse({ ...newDashboard('S'), widgets: [trend(binds)] }).success;
        expect([ok([]), ok(['/modules/a/x']), ok(Array.from({ length: 8 }, (_, i) => `/modules/m${i}/x`)), ok(Array.from({ length: 9 }, (_, i) => `/m${i}`))]).toEqual([false, true, true, false]);
        const t = trend(['/modules/a/statusData/stats/bitrate', '/modules/b/statusData/stats/rtt']);
        expect(rebindWidget(t, '/modules/a', '/modules/c').binds).toEqual(['/modules/c/statusData/stats/bitrate', '/modules/b/statusData/stats/rtt']);
        const copy = copyDashboard({ ...newDashboard('S'), widgets: [t] }, 'S2', { '/modules/b': '/modules/d' });
        expect(widgetPaths(copy.widgets[0])).toEqual(['/modules/a/statusData/stats/bitrate', '/modules/d/statusData/stats/rtt']);
    });

    it('finds a dashboard by name', () => {
        const all = { d1: newDashboard('Stage'), d2: newDashboard('Monitors') };
        expect(findDashboard(all, 'Monitors')?.[0]).toBe('d2');
        expect(findDashboard(all, 'Foyer')).toBeUndefined();
    });
});

describe('stored dashboards', () => {
    it('leaves out one that is not valid, keeps the rest as stored', () => {
        const good = newDashboard('Desk');
        const config = { dashboards: { a: good, b: { name: '', widgets: 'x' }, c: null } };
        const out = dashboardsOf(config);
        expect(Object.keys(out)).toEqual(['a']);
        expect(out.a).toBe(good);
        expect(dashboardsOf(null)).toEqual({});
        expect(dashboardsOf({ dashboards: 'nope' })).toEqual({});
    });
});

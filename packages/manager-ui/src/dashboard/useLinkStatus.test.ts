/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, reactive, ref, type ComputedRef } from 'vue';
import { mount } from '@vue/test-utils';
import { newDashboard, type Dashboard } from '@media-router/shared-types';
import { useLinkStatus, type LinkStatus } from './useLinkStatus';
import { routersOf } from './paths';
import type { DashboardSource } from './source';

function fakeSource(prefix = '') {
    const data = reactive<Record<string, unknown>>({});
    const connected = ref(true);
    const source = { prefix, connected, get: (p: string) => data[p], loaded: () => true, subscribe: () => () => {} } as unknown as DashboardSource;
    return { source, data, connected };
}

const board = (paths: string[]): Dashboard => ({
    ...newDashboard('B'),
    widgets: paths.map((bind, i) => ({ id: `w${i}`, type: 'readout', x: i, y: 0, w: 1, h: 1, bind })),
});

function status(source: DashboardSource, opts: { router?: boolean; offline?: boolean; paths?: string[] } = {}): ComputedRef<LinkStatus> {
    let s!: ComputedRef<LinkStatus>;
    const dashboard = board(opts.paths ?? []);
    mount(defineComponent({
        setup: () => {
            s = useLinkStatus({ source, dashboard: () => dashboard, offline: () => !!opts.offline, router: () => !!opts.router });
            return () => h('div');
        },
    }));
    return s;
}

describe('useLinkStatus', () => {
    it("on the router's own screen: amber while its manager is unreachable, green when back", () => {
        const { source, data } = fakeSource();
        const s = status(source, { router: true });
        data['/info/managerLink'] = { connected: false };
        expect(s.value.level).toBe('degraded');
        expect(s.value.reason).toMatch(/Manager unreachable/);
        data['/info/managerLink'] = { connected: true };
        expect(s.value.level).toBe('ok');
    });

    it('red when the page itself is disconnected, or its router is offline', () => {
        const a = fakeSource();
        const s = status(a.source, { router: true });
        a.connected.value = false;
        expect(s.value).toEqual({ level: 'down', reason: 'Not connected to the router.' });
        const b = fakeSource('/engines/e1');
        expect(status(b.source, { offline: true }).value.level).toBe('down');
    });

    it('a manager dashboard names the routers that are offline', () => {
        const { source, data } = fakeSource();
        const s = status(source, { paths: ['/engines/a/modules/m/settings/volume', '/engines/b/info/cpu'] });
        expect(s.value.level).toBe('ok');
        data['/engines/b/info/online'] = false;
        data['/engines/b/info/name'] = 'FRA01';
        expect(s.value).toEqual({ level: 'degraded', reason: 'Offline: FRA01. Its widgets show Stale.' });
    });

    it('collects routers from binds and actions', () => {
        const d = board(['/engines/a/x']);
        d.widgets.push({ id: 'b', type: 'button', x: 5, y: 0, w: 1, h: 1, action: { kind: 'call', path: '/engines/c', method: 'reboot' } });
        expect(routersOf(d)).toEqual(['a', 'c']);
    });
});

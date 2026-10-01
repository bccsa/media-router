/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import WidgetHost from './WidgetHost.vue';
import { TreeRequestError } from '@/tree/TreeClient';
import type { DashboardSource } from './source';
import { ASK, DASHBOARD_ID } from './keys';

const VOL = '/modules/m1/settings/volume';

function fakeSource(access: 'write' | 'read') {
    const data = reactive<Record<string, unknown>>({
        [VOL]: 80,
        [`/meta${VOL}`]: { access, type: 'number', min: 0, max: 100 },
        '/modules/m1/pluginId': 'audio-mixer',
    });
    return {
        prefix: '',
        connected: ref(true),
        get: (p: string) => data[p],
        loaded: () => true,
        subscribe: () => () => {},
        write: async () => ({ rejected: [] }),
        call: async () => ({}) as any,
        close() {},
    } as unknown as DashboardSource;
}

const host = (widget: Record<string, unknown>, access: 'write' | 'read' = 'write', editing = false) =>
    mount(WidgetHost, {
        props: {
            widget: { id: 'w', x: 0, y: 0, w: 2, h: 6, bind: VOL, ...widget } as any,
            source: fakeSource(access),
            offline: false,
            editing,
            rect: { left: 0, top: 0, width: 100, height: 300 },
        },
    });

describe('WidgetHost: display-only controls look it', () => {
    it('a live control is not marked', () => {
        expect(host({ type: 'fader' }).find('.dw-locked').exists()).toBe(false);
    });

    it('input disabled, or a read-only value, greys it and shows a lock', () => {
        for (const w of [host({ type: 'fader', inputDisabled: true }), host({ type: 'fader' }, 'read')]) {
            expect(w.find('.dw-locked').exists()).toBe(true);
            expect(w.find('.dw-lock').exists()).toBe(true);
        }
    });

    it('displays (readouts) and the editor are never marked', () => {
        expect(host({ type: 'readout' }, 'read').find('.dw-locked').exists()).toBe(false);
        expect(host({ type: 'fader', inputDisabled: true }, 'write', true).find('.dw-locked').exists()).toBe(false);
    });
});

describe('WidgetHost: buttons confirm through the dashboard popup', () => {
    function buttonHost(prefix: string, call: ReturnType<typeof vi.fn>, ask: ReturnType<typeof vi.fn>, options: Record<string, unknown> = {}) {
        const source = { ...fakeSource('write'), prefix, call } as unknown as DashboardSource;
        return mount(WidgetHost, {
            props: {
                widget: { id: 'b', type: 'button', x: 0, y: 0, w: 3, h: 2, options, action: { kind: 'call', path: '/', method: 'reboot' } } as any,
                source,
                offline: false,
                rect: { left: 0, top: 0, width: 200, height: 100 },
            },
            global: { provide: { [ASK as symbol]: ask } },
        });
    }
    const flush = () => new Promise((r) => setTimeout(r));

    it('calls reboot on the router itself, through the manager too', async () => {
        const call = vi.fn().mockResolvedValue({});
        const ask = vi.fn();
        await buttonHost('', call, ask).find('button').trigger('click');
        await buttonHost('/engines/e1', call, ask).find('button').trigger('click');
        await flush();
        expect(call.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
            ['/', 'reboot', undefined],
            ['/engines/e1', 'reboot', undefined],
        ]);
        expect(ask).not.toHaveBeenCalled();
    });

    it('"Ask to confirm" asks with the whole question; No does nothing', async () => {
        const call = vi.fn().mockResolvedValue({});
        const ask = vi.fn().mockResolvedValue(false);
        await buttonHost('', call, ask, { confirm: true, text: 'Reboot' }).find('button').trigger('click');
        await flush();
        expect(ask).toHaveBeenCalledWith('Reboot?', expect.stringMatching(/reboots now/));
        expect(call).not.toHaveBeenCalled();
    });

    it('a reset asks with its own consequence, then calls reset on the router', async () => {
        const call = vi.fn().mockResolvedValue({});
        const ask = vi.fn().mockResolvedValue(true);
        const source = { ...fakeSource('write'), prefix: '', call } as unknown as DashboardSource;
        const w = mount(WidgetHost, {
            props: {
                widget: { id: 'r', type: 'button', x: 0, y: 0, w: 3, h: 2, options: { confirm: true, text: 'Reset' }, action: { kind: 'call', path: '/', method: 'reset' } } as any,
                source,
                offline: false,
                rect: { left: 0, top: 0, width: 200, height: 100 },
            },
            global: { provide: { [ASK as symbol]: ask } },
        });
        await w.find('button').trigger('click');
        await flush();
        expect(ask).toHaveBeenCalledWith('Reset?', expect.stringMatching(/every module restart/));
        expect(call).toHaveBeenCalledWith('/', 'reset', undefined);
    });

    it('without a manager it asks again, and Yes forces the reboot', async () => {
        const call = vi
            .fn()
            .mockRejectedValueOnce(new TreeRequestError('The manager is unreachable', 'needs-confirm'))
            .mockResolvedValue({});
        const ask = vi.fn().mockResolvedValue(true);
        await buttonHost('', call, ask).find('button').trigger('click');
        await flush();
        expect(ask).toHaveBeenCalledWith('Reboot anyway?', expect.stringMatching(/stays stopped/));
        expect(call).toHaveBeenLastCalledWith('/', 'reboot', { confirm: true });
    });

    it('any other refusal flashes and does not ask', async () => {
        const call = vi.fn().mockRejectedValue(new Error('The manager is unreachable'));
        const ask = vi.fn().mockResolvedValue(true);
        const w = buttonHost('', call, ask);
        await w.find('button').trigger('click');
        await flush();
        expect(ask).not.toHaveBeenCalledWith('Reboot anyway?', expect.anything());
        expect(call).toHaveBeenCalledTimes(1);
        expect(w.find('.dw-rejected').exists()).toBe(true);
    });
});

describe('WidgetHost: a trend gets each value with its label and live state', () => {
    it('labels by router, module and value, and marks a value whose router is down', () => {
        const data = reactive<Record<string, unknown>>({
            '/engines/a/modules/m1/statusData/stats/bitrate': 2.5,
            '/meta/engines/a/modules/m1/statusData/stats/bitrate': { access: 'read', type: 'number', label: 'Bitrate', unit: 'Mbps' },
            '/engines/a/modules/m1/pluginId': 'srt-input',
            '/engines/a/modules/m1/displayName': 'Chat IN',
            '/engines/a/info/name': 'FRA01',
            '/engines/b/modules/m2/statusData/stats/rtt': 3,
            '/meta/engines/b/modules/m2/statusData/stats/rtt': { access: 'read', type: 'number', label: 'RTT', unit: 'ms' },
            '/engines/b/modules/m2/pluginId': 'rist-input',
            '/engines/b/modules/m2/displayName': 'Feed',
            '/engines/b/info/name': 'NYA01',
            '/engines/b/info/online': false,
        });
        const source = { ...fakeSource('write'), get: (p: string) => data[p] } as unknown as DashboardSource;
        const w = mount(WidgetHost, {
            props: {
                widget: { id: 't', type: 'trend', x: 0, y: 0, w: 8, h: 5, binds: ['/engines/a/modules/m1/statusData/stats/bitrate', '/engines/b/modules/m2/statusData/stats/rtt'] } as any,
                source,
                offline: false,
                rect: { left: 0, top: 0, width: 400, height: 250 },
            },
        });
        const chart = w.findComponent({ name: 'TrendChart' });
        const series = chart.props('series') as Array<{ label: string; live: boolean }>;
        expect(series.map((s) => [s.label, s.live])).toEqual([
            ['FRA01 · Chat IN · Bitrate', true],
            ['NYA01 · Feed · RTT', false],
        ]);
        expect(w.find('.dw').classes()).toContain('state-ok');
        w.unmount();
    });
});

describe('WidgetHost: a button with several actions runs them on the server', () => {
    function scripted(call: ReturnType<typeof vi.fn>, ask: ReturnType<typeof vi.fn>, data: Record<string, unknown> = {}) {
        const values = reactive<Record<string, unknown>>(data);
        const source = { ...fakeSource('write'), prefix: '/engines/e1', call, get: (p: string) => values[p] } as unknown as DashboardSource;
        const w = mount(WidgetHost, {
            props: {
                widget: { id: 'b1', type: 'button', x: 0, y: 0, w: 3, h: 2, options: { confirm: true, text: 'Go' },
                    script: { steps: [{ do: 'call', path: '/modules/m1', method: 'restart' }, { do: 'wait', seconds: { lit: 2 } }] } } as any,
                source,
                offline: false,
                rect: { left: 0, top: 0, width: 200, height: 100 },
            },
            global: { provide: { [ASK as symbol]: ask, [DASHBOARD_ID as symbol]: ref('d1') } },
        });
        return { w, values };
    }
    const flush = () => new Promise((r) => setTimeout(r));

    it('confirms with the list, then calls run on the dashboard it sits in', async () => {
        const call = vi.fn().mockResolvedValue({});
        const ask = vi.fn().mockResolvedValue(true);
        await scripted(call, ask).w.find('button').trigger('click');
        await flush();
        expect(ask).toHaveBeenCalledWith('Go?', 'Runs 2 actions: restart m1, wait 2 s.');
        expect(call).toHaveBeenCalledWith('/engines/e1/dashboards/d1', 'run', { widget: 'b1' });
    });

    it('while running it shows the step and a press offers Stop', async () => {
        const call = vi.fn().mockResolvedValue({});
        const ask = vi.fn().mockResolvedValue(true);
        const { w } = scripted(call, ask, { '/runs/e1/d1/b1': { state: 'running', step: 1, of: 2, at: Date.now() } });
        expect(w.text()).toContain('1/2 · tap to stop');
        await w.find('button').trigger('click');
        await flush();
        expect(ask).toHaveBeenCalledWith('Stop the running actions?');
        expect(call).toHaveBeenCalledWith('/engines/e1/dashboards/d1', 'stop', { widget: 'b1' });
    });

    it('a failed run shows which step failed and why', async () => {
        const { w, values } = scripted(vi.fn(), vi.fn());
        values['/runs/e1/d1/b1'] = { state: 'failed', step: 2, of: 2, error: 'volume: above 150', at: Date.now() + 1 };
        await flush();
        expect(w.text()).toContain('Step 2: volume: above 150');
    });
});

describe('WidgetHost: label size and weight', () => {
    it('passes the size when set, and the weight as Bold says — the kind’s default included', () => {
        const host = (type: string, options: Record<string, unknown>) =>
            mount(WidgetHost, {
                props: { widget: { id: 'l', type, x: 0, y: 0, w: 4, h: 1, options } as any, source: fakeSource('read'), offline: false, rect: { left: 0, top: 0, width: 100, height: 40 } },
            });
        const vars = (type: string, options: Record<string, unknown>) => {
            const style = (host(type, options).find('.dw').element as HTMLElement).style;
            return [style.getPropertyValue('--dw-label-size'), style.getPropertyValue('--dw-label-weight')];
        };
        expect(vars('label', { labelSize: 18, labelBold: false })).toEqual(['18px', '400']);
        // Unset: a label is bold by default (as its inspector shows), a readout is not.
        expect(vars('label', {})).toEqual(['', '700']);
        expect(vars('readout', {})).toEqual(['', '400']);
    });
});


import { describe, it, expect, vi } from 'vitest';
import { bounds, clampBox, firstFree, gridMetrics, CELL_PX } from './grid';
import { dragValue, fraction, throttled } from './drag';
import { builtinDescriptor, moduleEntries, routerEntries } from './entries';
import { routerRelative } from './paths';
import { WIDGETS, WIDGET_LIST, canBind, optionsOf, takesInput } from './registry';
import { asNumber, formatValue, readableText, stepDecimals } from './valueTypes';

describe('readable text colours', () => {
    it('keeps an accent that reads on the theme, drops one that would vanish', () => {
        expect(readableText('#101312', 'dark')).toBeUndefined();
        expect(readableText('#10b981', 'dark')).toBe('#10b981');
        expect(readableText('#ffffff', 'light')).toBeUndefined();
        expect(readableText('#101312', 'light')).toBe('#101312');
        expect(readableText(undefined, 'dark')).toBeUndefined();
    });
});

describe('number values', () => {
    it('reads number stats sent as text, and treats the idle dash or formatted text as no value', () => {
        expect([2.5, '2.01', ' 3 ', '-0.5', '—', '957.6 MB', '0.00%', null, NaN].map(asNumber)).toEqual([2.5, 2.01, 3, -0.5, undefined, undefined, undefined, undefined, undefined]);
    });
});

describe('grid', () => {
    it('stretches cells to the box, or fixes them when scrolling', () => {
        expect(gridMetrics({ cols: 24, rows: 12, scroll: false }, { width: 1200, height: 600 })).toEqual({ cw: 50, ch: 50, width: 1200, height: 600 });
        expect(gridMetrics({ cols: 24, rows: 12, scroll: true }, { width: 100, height: 100 })).toEqual({ cw: CELL_PX, ch: CELL_PX, width: 24 * CELL_PX, height: 12 * CELL_PX });
    });

    it('clamps boxes into the grid and finds the first free spot', () => {
        expect(clampBox({ x: 23, y: -2, w: 4, h: 30 }, { cols: 24, rows: 14 })).toEqual({ x: 20, y: 0, w: 4, h: 14 });
        const taken = [{ x: 0, y: 0, w: 4, h: 2 }];
        expect(firstFree(taken, { w: 2, h: 2 }, { cols: 24, rows: 14 })).toEqual({ x: 4, y: 0 });
        expect(firstFree([{ x: 0, y: 0, w: 4, h: 4 }], { w: 4, h: 4 }, { cols: 4, rows: 4 })).toEqual({ x: 0, y: 0 });
        expect(bounds([{ id: 'a', type: 'x', x: 1, y: 1, w: 2, h: 2 }, { id: 'b', type: 'x', x: 5, y: 0, w: 1, h: 5 }])).toEqual({ x: 1, y: 0, w: 5, h: 5 });
    });
});

describe('grab and drag', () => {
    it('moves by the travel, from the start value, stepped and clamped', () => {
        expect(dragValue(50, 100, 200, 0, 100)).toBe(100);
        expect(dragValue(50, -30, 300, 0, 150, 1)).toBe(35);
        expect(dragValue(0.1, 1, 10, 0, 1, 0.1)).toBe(0.2);
        expect(dragValue(95, 1000, 100, 0, 100)).toBe(100);
        expect(fraction(75, 0, 150)).toBe(0.5);
    });

    it('sends at most one value per interval, the latest wins, and the release is final', () => {
        vi.useFakeTimers();
        const sent: number[] = [];
        const t = throttled((v: number) => sent.push(v), 100);
        t.push(1);
        t.push(2);
        t.push(3);
        vi.advanceTimersByTime(100);
        t.push(4);
        t.end(5);
        expect(sent).toEqual([1, 3, 4, 5]);
        t.push(6);
        t.end(6);
        expect(sent).toEqual([1, 3, 4, 5, 6]);
        vi.useRealTimers();
    });
});

describe('entries', () => {
    const meta = {
        settings: { volume: { access: 'write' as const, apply: 'live' as const, type: 'number', min: 0, max: 150, label: 'Volume' } },
        statusData: { stats: { bitrate: { access: 'read' as const, label: 'Bitrate', unit: 'kbps' } } },
        enabled: { access: 'write' as const, apply: 'live' as const, type: 'boolean', label: 'Enabled' },
    };

    it('lists a module\'s settings, status (typed from the value), state, enabled and levels', () => {
        const levels = { access: 'read' as const, type: 'array', min: 0, max: 15, label: 'Levels' };
        const e = moduleEntries('/modules/m1', { ...meta, vu: levels }, { statusData: { stats: { bitrate: 128 } } });
        expect(e.map((x) => [x.path, x.kind])).toEqual([
            ['/modules/m1/settings/volume', 'setting'],
            ['/modules/m1/statusData/stats/bitrate', 'status'],
            ['/modules/m1/health', 'state'],
            ['/modules/m1/running', 'state'],
            ['/modules/m1/pendingRestart', 'state'],
            ['/modules/m1/enabled', 'field'],
            ['/modules/m1/vu', 'vu'],
        ]);
        expect(e[1].desc.type).toBe('number');
        // Levels only where /meta says the module has them (ADR-0007), with their range.
        expect(moduleEntries('/modules/m1', meta, { vu: [3, 4] }).some((x) => x.kind === 'vu')).toBe(false);
        expect(e.find((x) => x.kind === 'vu')?.desc.max).toBe(15);
    });

    it('describes values /meta does not, on a router and through the manager alike', () => {
        expect(routerRelative('/engines/e1/system/cpu')).toBe('/system/cpu');
        expect(builtinDescriptor('/system/cpu')).toMatchObject({ min: 0, max: 100, unit: '%' });
        expect(builtinDescriptor('/engines/e1/modules/m1/health')?.enum).toEqual(['ok', 'warning', 'error', 'stopped']);
        expect(builtinDescriptor('/modules/m1/settings/volume')).toBeUndefined();
        expect(routerEntries('', { access: 'write', type: 'boolean' }).map((e) => e.path)).toContain('/info/running');
        expect(routerEntries('/engines/e1', undefined).find((e) => e.path === '/engines/e1/info/name')?.label).toBe('Name');
    });
});

describe('widget registry', () => {
    const entry = (kind: any, desc: any) => ({ path: '/x', label: 'x', kind, desc });
    const vol = entry('setting', { access: 'write', type: 'number', min: 0, max: 150 });
    const bitrate = entry('status', { access: 'read', type: 'number' });
    const cpu = entry('router', { access: 'read', type: 'number', min: 0, max: 100 });
    const mute = entry('setting', { access: 'write', type: 'boolean' });
    const health = entry('state', { access: 'read', type: 'string', enum: ['ok', 'warning', 'error', 'stopped'] });
    const vu = entry('vu', { access: 'read', type: 'array' });
    const codec = entry('setting', { access: 'write', type: 'string', enum: ['opus', 'aac'] });

    it('every widget that can send a write or an action offers "Input disabled"; display widgets do not', () => {
        for (const def of WIDGET_LIST) {
            const emits = (def.component as { emits?: string[] | Record<string, unknown> }).emits ?? [];
            const names = Array.isArray(emits) ? emits : Object.keys(emits);
            expect([def.type, takesInput(def)]).toEqual([def.type, names.includes('write') || names.includes('action')]);
        }
        expect(WIDGET_LIST.filter(takesInput).length).toBeGreaterThanOrEqual(7);
    });

    it('registers each widget folder once, in palette order, and nothing from shared/', () => {
        const orders = WIDGET_LIST.map((w) => w.order);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(new Set(orders).size).toBe(orders.length);
        expect(WIDGET_LIST.map((w) => w.type)).toEqual(expect.arrayContaining(['fader', 'slider', 'number', 'toggle', 'button', 'trend', 'label']));
        expect(WIDGETS.shared).toBeUndefined();
    });

    it('offers each widget only the values it takes; controls need a writable one unless input is disabled', () => {
        const takes = (type: string, e: any, disabled = false) => canBind(WIDGETS[type], e, disabled);
        expect([vol, bitrate, cpu].map((e) => takes('fader', e))).toEqual([true, false, false]);
        expect(takes('fader', cpu, true)).toBe(true);
        // Any number goes on a trend, levels too; text does not.
        const levels = entry('vu', { access: 'read', type: 'array' });
        const mode = entry('status', { access: 'read', type: 'string' });
        expect([vol, bitrate, cpu, levels, mode].map((e) => takes('trend', e))).toEqual([true, true, true, true, false]);
        expect([vol, bitrate].map((e) => takes('number', e))).toEqual([true, false]);
        expect([mute, health].map((e) => takes('toggle', e))).toEqual([true, false]);
        expect([codec, health].map((e) => takes('dropdown', e))).toEqual([true, false]);
        expect([vol, bitrate, mute, health, vu].map((e) => takes('readout', e))).toEqual([true, true, true, true, false]);
        expect([mute, health, codec].map((e) => takes('light', e))).toEqual([true, true, false]);
        expect([vu, vol].map((e) => takes('vu', e))).toEqual([true, false]);
        expect([cpu, vol, bitrate].map((e) => takes('gauge', e))).toEqual([true, true, false]);
        expect(takes('button', vol)).toBe(false);
        expect(takes('label', vol)).toBe(false);
    });

    it('fills in option defaults under the widget\'s own options', () => {
        expect(optionsOf(WIDGETS.fader, { id: 'w', type: 'fader', x: 0, y: 0, w: 1, h: 1, options: { showUnit: false } })).toMatchObject({
            step: undefined,
            showValue: true,
            showUnit: false,
            labelBold: false,
        });
        // A button's face and a label's text are bold until turned off.
        expect(optionsOf(WIDGETS.button, { id: 'b', type: 'button', x: 0, y: 0, w: 1, h: 1 }).labelBold).toBe(true);
        expect(optionsOf(WIDGETS.label, { id: 'l', type: 'label', x: 0, y: 0, w: 1, h: 1, options: { labelBold: false } }).labelBold).toBe(false);
    });
});

describe('value formatting', () => {
    it('formats numbers, lists and switches', () => {
        expect(formatValue(12.3456, 1, 'dB')).toBe('12.3 dB');
        expect(formatValue(['10.0.0.1', '10.0.0.2'])).toBe('10.0.0.1, 10.0.0.2');
        expect(formatValue(true)).toBe('On');
        expect(formatValue(undefined)).toBe('—');
        expect([stepDecimals(0.25), stepDecimals(1), stepDecimals(undefined)]).toEqual([2, 0, 0]);
    });
});

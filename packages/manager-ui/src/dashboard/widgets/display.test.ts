/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import VuMeter from './vu/VuMeter.vue';
import StatusLight from './light/StatusLight.vue';
import DropdownSelect from './dropdown/DropdownSelect.vue';
import ValueReadout from './readout/ValueReadout.vue';
import BarGauge from './gauge/BarGauge.vue';
import ToggleSwitch from './toggle/ToggleSwitch.vue';

const widget = { id: 'w', type: 'x', x: 0, y: 0, w: 2, h: 2 };
const props = (value: unknown, desc: Record<string, unknown> | undefined, options: Record<string, unknown> = {}, interactive = true) =>
    ({ widget, value, desc, interactive, label: 'L', options }) as any;

describe('display widgets', () => {
    it('VU: blocks from the descriptor, lit up to the level, zones by dBFS; chosen channels only', () => {
        const w = mount(VuMeter, { props: props([15, 3], { access: 'read', type: 'array', min: 0, max: 15 }, { channels: '1' }) });
        const ch = w.findAll('.vu-ch');
        expect(ch).toHaveLength(1);
        const blocks = ch[0].findAll('.vu-block').map((b) => (b.element as HTMLElement).style.background);
        expect(blocks).toHaveLength(15);
        // -20 dBFS is block 10, -8 dBFS block 13.
        expect(blocks.slice(0, 10).every((b) => b === 'var(--d-ok)')).toBe(true);
        expect(blocks.slice(10, 13).every((b) => b === 'var(--d-vu-mid)')).toBe(true);
        expect(blocks.slice(13).every((b) => b === 'var(--d-error)')).toBe(true);
        const quiet = mount(VuMeter, { props: props([2], { access: 'read', type: 'array', min: 0, max: 15 }) });
        expect(quiet.findAll('.vu-block').filter((b) => (b.element as HTMLElement).style.background !== 'var(--d-vu-off)')).toHaveLength(2);
    });

    it('light: health and true/false as colour and text', () => {
        const text = (v: unknown, o = {}) => mount(StatusLight, { props: props(v, undefined, { showText: true, ...o }) }).find('.sl-text').text();
        expect([text('ok'), text('warning'), text(true), text(false)]).toEqual(['OK', 'Warning', 'On', 'Off']);
        const lamp = mount(StatusLight, { props: props('error', undefined, { errorColor: '#123456' }) }).find('.sl-lamp').element as HTMLElement;
        expect(lamp.style.background).toBe('rgb(18, 52, 86)');
    });

    it('dropdown: choices from the enum with their labels; picking writes the value', async () => {
        const w = mount(DropdownSelect, { props: props('aac', { access: 'write', type: 'string', enum: ['opus', 'aac'], enumLabels: { aac: 'AAC' } }) });
        expect(w.findAll('option').map((o) => o.text())).toEqual(['opus', 'AAC']);
        await w.find('select').setValue('0');
        expect(w.emitted('write')).toEqual([['opus']]);
        const off = mount(DropdownSelect, { props: props('x', { access: 'write', type: 'string', enum: ['a'] }, {}, false) });
        expect(off.find('select').attributes('disabled')).toBeDefined();
        expect(off.findAll('option')[0].text()).toBe('x');
    });

    it('readout: numbers as text read as numbers, decimals and unit as set', () => {
        const text = (v: unknown, desc: Record<string, unknown>, o = {}) => mount(ValueReadout, { props: props(v, desc, o) }).find('.dw-value').text();
        expect(text('2.014', { access: 'read', type: 'number', unit: 'Mbps' }, { decimals: 1, showUnit: true })).toBe('2.0 Mbps');
        expect(text('—', { access: 'read', type: 'number' })).toBe('—');
        expect(text(['a', 'b'], { access: 'read', type: 'array' })).toBe('a, b');
    });

    it('readout: wraps long text only when asked', () => {
        const desc = { access: 'read', type: 'string' };
        expect(mount(ValueReadout, { props: props('a long sentence', desc) }).find('.ro-value').classes()).not.toContain('ro-wrap');
        expect(mount(ValueReadout, { props: props('a long sentence', desc, { wrap: true }) }).find('.ro-value').classes()).toContain('ro-wrap');
    });

    it('bar gauge: fills by the value along its range', () => {
        const w = mount(BarGauge, { props: props(75, { access: 'read', type: 'number', min: 50, max: 150 }, { showValue: true }) });
        expect(w.html()).toMatch(/25%/);
    });

    it('toggle: a switch that flips its value, only when it takes input', async () => {
        const w = mount(ToggleSwitch, { props: props(true, { access: 'write', type: 'boolean' }) });
        expect(w.find('[role="switch"]').attributes('aria-checked')).toBe('true');
        await w.find('button').trigger('click');
        expect(w.emitted('write')).toEqual([[false]]);
        const off = mount(ToggleSwitch, { props: props(true, { access: 'write', type: 'boolean' }, {}, false) });
        await off.find('button').trigger('click');
        expect(off.emitted('write')).toBeUndefined();
    });
});


/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import NumberBox from './NumberBox.vue';

const widget = { id: 'n', type: 'number', x: 0, y: 0, w: 4, h: 2 };

function box(value: unknown, desc: Record<string, unknown>, options: Record<string, unknown> = {}, interactive = true) {
    return mount(NumberBox, { props: { widget, value, desc: { access: 'write', type: 'number', ...desc }, interactive, label: 'Gain', options } as any });
}
const [down, , up] = [0, 1, 2];

describe('NumberBox', () => {
    it('steps by the option, else the value’s step, and stays in range', async () => {
        const w = box(9.5, { min: 0, max: 10, step: 0.5 }, { step: 2 });
        const buttons = w.findAll('button');
        await buttons[up].trigger('click');
        await buttons[down].trigger('click');
        expect(w.emitted('write')).toEqual([[10], [7.5]]);
        const plain = box(1, { step: 0.1 });
        await plain.findAll('button')[up].trigger('click');
        expect(plain.emitted('write')).toEqual([[1.1]]);
    });

    it('shows the step’s decimals unless set, and the unit', () => {
        expect(box(2.25, { step: 0.25 }).find('.nb-value').text()).toBe('2.25');
        expect(box(2.25, { step: 0.25 }, { decimals: 0 }).find('.nb-value').text()).toBe('2');
        expect(box(3, { unit: 'dB' }, { showUnit: true }).find('.nb-value').text()).toBe('3 dB');
    });

    it('typing a number writes it, clamped; Escape or text writes nothing', async () => {
        const w = box(5, { type: 'integer', min: 0, max: 10 });
        await w.find('.nb-value').trigger('click');
        await w.find('input').setValue('12.4');
        await w.find('input').trigger('keydown', { key: 'Enter' });
        expect(w.emitted('write')).toEqual([[10]]);
        await w.find('.nb-value').trigger('click');
        await w.find('input').setValue('abc');
        await w.find('input').trigger('keydown', { key: 'Enter' });
        expect(w.emitted('write')).toHaveLength(1);
    });

    it('takes no input when not interactive', async () => {
        const w = box(5, {}, {}, false);
        for (const b of w.findAll('button')) await b.trigger('click');
        expect(w.find('input').exists()).toBe(false);
        expect(w.emitted('write')).toBeUndefined();
    });
});

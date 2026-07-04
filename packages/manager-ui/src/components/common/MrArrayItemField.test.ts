// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrArrayItemField, { type ItemField } from './MrArrayItemField.vue';

const codecField: ItemField = {
    key: 'codec',
    type: 'string',
    description: 'Codec',
    enumValues: ['h264', 'h265'],
    enumLabels: { h264: 'H.264', h265: 'H.265' },
    advanced: true,
};

const sceneCutField: ItemField = {
    key: 'sceneCut',
    type: 'number',
    description: 'Scene cut',
    advanced: true,
};

describe('MrArrayItemField — advanced enum', () => {
    it('prepends an "Inherit (global)" option and shows the enum label', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: codecField, value: undefined },
        });
        await wrapper.find('button').trigger('click');
        const items = wrapper.findAll('.cursor-pointer');
        expect(items.map((i) => i.text())).toEqual(['Inherit (global)', 'H.264', 'H.265']);
    });

    it('emits update with the picked value', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: codecField, value: undefined },
        });
        await wrapper.find('button').trigger('click');
        await wrapper.findAll('.cursor-pointer')[2].trigger('click'); // H.265
        expect(wrapper.emitted('update')?.[0]).toEqual(['h265']);
        expect(wrapper.emitted('clear')).toBeFalsy();
    });

    it('emits clear (inherit) when the Inherit option is chosen', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: codecField, value: 'h265' },
        });
        await wrapper.find('button').trigger('click');
        await wrapper.findAll('.cursor-pointer')[0].trigger('click'); // Inherit (global)
        expect(wrapper.emitted('clear')).toBeTruthy();
        expect(wrapper.emitted('update')).toBeFalsy();
    });
});

describe('MrArrayItemField — advanced number', () => {
    it('shows the inherit placeholder and no reset button when unset', () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: sceneCutField, value: undefined },
        });
        expect(wrapper.find('input').attributes('placeholder')).toBe('Inherit (global)');
        expect(wrapper.find('button').exists()).toBe(false);
    });

    it('emits update with the typed number', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: sceneCutField, value: undefined },
        });
        await wrapper.find('input').setValue('0');
        expect(wrapper.emitted('update')?.[0]).toEqual([0]);
    });

    it('offers a reset-to-inherit button once set and emits clear on click', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: sceneCutField, value: 25 },
        });
        const reset = wrapper.find('button');
        expect(reset.exists()).toBe(true);
        await reset.trigger('click');
        expect(wrapper.emitted('clear')).toBeTruthy();
    });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrInput from './MrInput.vue';

function wheelOn(el: HTMLElement) {
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    el.dispatchEvent(wheel);
    return wheel;
}

describe('MrInput', () => {
    it('blurs the focused number input on wheel instead of changing the value', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 42, type: 'number' },
            attachTo: document.body,
        });
        const el = wrapper.find('input').element as HTMLInputElement;
        el.focus();
        expect(document.activeElement).toBe(el);

        const wheel = wheelOn(el);
        await wrapper.vm.$nextTick();

        expect(document.activeElement).not.toBe(el);
        expect(el.value).toBe('42');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        // Default is left alone so the page still scrolls over the input
        expect(wheel.defaultPrevented).toBe(false);

        wrapper.unmount();
    });

    it('keeps focus on a text input when scrolled over', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 'hello', type: 'text' },
            attachTo: document.body,
        });
        const el = wrapper.find('input').element as HTMLInputElement;
        el.focus();

        const wheel = wheelOn(el);
        await wrapper.vm.$nextTick();

        expect(document.activeElement).toBe(el);
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wheel.defaultPrevented).toBe(false);

        wrapper.unmount();
    });

    it('clamps emitted number input to min and max', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 5, type: 'number', min: 0, max: 10 },
        });
        const input = wrapper.find('input');
        await input.setValue('99');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([10]);
        await input.setValue('-99');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([0]);
    });
});

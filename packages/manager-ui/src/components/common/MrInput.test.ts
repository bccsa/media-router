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

    // `setValue` fires input AND change, so drive the events by hand to tell a
    // keystroke (input) from a commit (change = Enter/blur).
    async function type(wrapper: ReturnType<typeof mount>, text: string) {
        const input = wrapper.find('input');
        (input.element as HTMLInputElement).value = text;
        await input.trigger('input');
    }

    it('emits in-range keystrokes immediately and clamps out-of-range ones on commit', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 5, type: 'number', min: 0, max: 10 },
        });
        const input = wrapper.find('input');
        await type(wrapper, '7');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([7]);
        await type(wrapper, '99');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([7]);
        await input.trigger('change');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([10]);
        expect((input.element as HTMLInputElement).value).toBe('10');
        await type(wrapper, '-99');
        await input.trigger('change');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([0]);
    });

    it('lets 48 be typed digit by digit with min 6 (#664): "4" is held, "48" is emitted', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 128, type: 'number', min: 6, max: 510 },
        });
        await type(wrapper, '4');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe('4');
        await type(wrapper, '48');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([48]);
    });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrSlider from './MrSlider.vue';

describe('MrSlider', () => {
    it('emits update:modelValue when range slider changes', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100 },
        });
        const range = wrapper.find('input[type="range"]');
        await range.setValue('75');
        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0]).toEqual([75]);
    });

    it('shows static value span when showValue is true', () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 42, showValue: true, unit: '%' },
        });
        expect(wrapper.text()).toContain('42%');
        expect(wrapper.find('input[type="number"]').exists()).toBe(false);
    });

    it('renders an editable number input when editable is true', () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 30, min: 0, max: 100, editable: true, unit: '%' },
        });
        const num = wrapper.find('input[type="number"]');
        expect(num.exists()).toBe(true);
        expect((num.element as HTMLInputElement).value).toBe('30');
        expect(wrapper.text()).toContain('%');
    });

    it('emits typed value through editable input', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 30, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('80');
        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted!.at(-1)).toEqual([80]);
    });

    it('clamps typed value above max', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        await wrapper.find('input[type="number"]').setValue('999');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([100]);
    });

    it('clamps typed value below min', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 10, max: 100, editable: true },
        });
        await wrapper.find('input[type="number"]').setValue('-5');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([10]);
    });

    it('ignores non-numeric typed input', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        // jsdom strips non-numeric chars from number inputs; emulate empty result
        (num.element as HTMLInputElement).value = '';
        await num.trigger('input');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('formats display value with explicit precision', () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 0.756, showValue: true, precision: 2 },
        });
        expect(wrapper.text()).toContain('0.76');
    });

    it('derives precision from step when not provided', () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 0.756, showValue: true, step: 0.01 },
        });
        expect(wrapper.text()).toContain('0.76');
    });

    it('uses zero precision for integer step', () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 75.4, showValue: true, step: 1 },
        });
        expect(wrapper.text()).toContain('75');
        expect(wrapper.text()).not.toContain('75.4');
    });

    it('flags clamped state on out-of-range typed input', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('999');
        expect(num.classes()).toContain('border-amber-500');
    });

    it('does not flag clamped state for in-range input', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('60');
        expect(num.classes()).not.toContain('border-amber-500');
    });

    it('blurs the focused number input on wheel instead of changing the value', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
            attachTo: document.body,
        });
        const el = wrapper.find('input[type="number"]').element as HTMLInputElement;
        el.focus();
        expect(document.activeElement).toBe(el);

        const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        el.dispatchEvent(wheel);
        await wrapper.vm.$nextTick();

        expect(document.activeElement).not.toBe(el);
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        // Default is left alone so the page still scrolls over the input
        expect(wheel.defaultPrevented).toBe(false);

        wrapper.unmount();
    });

    it('blurs the focused range input on wheel instead of changing the value', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100 },
            attachTo: document.body,
        });
        const el = wrapper.find('input[type="range"]').element as HTMLInputElement;
        el.focus();
        expect(document.activeElement).toBe(el);

        const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
        el.dispatchEvent(wheel);
        await wrapper.vm.$nextTick();

        expect(document.activeElement).not.toBe(el);
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wheel.defaultPrevented).toBe(false);

        wrapper.unmount();
    });
});

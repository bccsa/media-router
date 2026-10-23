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

    it('refuses a typed value above max with the reason, never the bound (B-104)', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 150, editable: true, unit: '%' },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('999');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect((num.element as HTMLInputElement).value).toBe('999');
        expect(wrapper.get('[data-test="reason"]').text()).toBe('Must be between 0 and 150 %');
    });

    it('refuses a typed value below min with the reason', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 10, max: 100, editable: true },
        });
        await wrapper.find('input[type="number"]').setValue('-5');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.get('[data-test="reason"]').text()).toBe('Must be between 10 and 100');
    });

    it('the typed box writes nothing per keystroke, once at commit, and keeps its text through a re-render', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 4000, min: 128, max: 20000, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        const el = num.element as HTMLInputElement;
        // "5" on the way to 5000 is below min: neither clamped to 128 nor written.
        for (const typed of ['5', '50', '500']) {
            el.value = typed;
            await num.trigger('input');
        }
        await wrapper.setProps({ modelValue: 4100 });
        expect(el.value).toBe('500');
        el.value = '5000';
        await num.trigger('input');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.find('[data-test="reason"]').exists()).toBe(false);
        await num.trigger('change');
        expect(wrapper.emitted('update:modelValue')).toEqual([[5000]]);
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

    it('marks a refused box until typing resumes', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('999');
        expect(num.classes()).toContain('border-error');
        (num.element as HTMLInputElement).value = '9';
        await num.trigger('input');
        expect(num.classes()).not.toContain('border-error');
        expect(wrapper.find('[data-test="reason"]').exists()).toBe(false);
    });

    it('does not mark an in-range entry', async () => {
        const wrapper = mount(MrSlider, {
            props: { modelValue: 50, min: 0, max: 100, editable: true },
        });
        const num = wrapper.find('input[type="number"]');
        await num.setValue('60');
        expect(num.classes()).not.toContain('border-error');
        expect(wrapper.emitted('update:modelValue')).toEqual([[60]]);
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

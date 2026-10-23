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
    // keystroke (input) from a commit (change = Enter, leaving the box, a spinner step).
    async function type(wrapper: ReturnType<typeof mount>, text: string) {
        const input = wrapper.find('input');
        (input.element as HTMLInputElement).value = text;
        await input.trigger('input');
    }
    const reason = (wrapper: ReturnType<typeof mount>) =>
        wrapper.find('[data-test="reason"]').exists()
            ? wrapper.get('[data-test="reason"]').text()
            : undefined;

    it('a number box writes nothing per keystroke and once at commit; out of range is refused (B-104)', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 5, type: 'number', min: 0, max: 10 },
        });
        const input = wrapper.find('input');
        await type(wrapper, '7');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        await input.trigger('change');
        expect(wrapper.emitted('update:modelValue')).toEqual([[7]]);

        await type(wrapper, '99');
        expect(reason(wrapper)).toBeUndefined();
        await input.trigger('change');
        // Refused, not clamped: the text stays with the reason and the stored value stays in force.
        expect(wrapper.emitted('update:modelValue')).toEqual([[7]]);
        expect((input.element as HTMLInputElement).value).toBe('99');
        expect(reason(wrapper)).toBe('Must be between 0 and 10');
        expect(input.classes()).toContain('border-error');
    });

    it('lets 48 be typed digit by digit with min 6 (#664): "4" is neither refused nor written', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 128, type: 'number', min: 6, max: 510 },
        });
        await type(wrapper, '4');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(reason(wrapper)).toBeUndefined();
        expect((wrapper.find('input').element as HTMLInputElement).value).toBe('4');
        await type(wrapper, '48');
        await wrapper.find('input').trigger('change');
        expect(wrapper.emitted('update:modelValue')).toEqual([[48]]);
    });

    it('a negative number can be typed over a stored one: "-" is held, not read as 0', async () => {
        const wrapper = mount(MrInput, { props: { modelValue: 12, type: 'number' } });
        const el = wrapper.find('input').element as HTMLInputElement;
        // A number box reads "-" back as '' with badInput set.
        el.value = '';
        Object.defineProperty(el, 'validity', { configurable: true, value: { badInput: true } });
        await wrapper.find('input').trigger('input');
        await wrapper.setProps({ modelValue: 12 });
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        await wrapper.find('input').trigger('change');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(reason(wrapper)).toBe('Enter a number');

        Reflect.deleteProperty(el, 'validity');
        await type(wrapper, '-5');
        await wrapper.find('input').trigger('change');
        expect(wrapper.emitted('update:modelValue')).toEqual([[-5]]);
    });

    it('an unchanged commit writes nothing; an empty number box is refused', async () => {
        const wrapper = mount(MrInput, { props: { modelValue: 5, type: 'number' } });
        await wrapper.find('input').setValue('5');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        await wrapper.find('input').setValue('');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(reason(wrapper)).toBe('Enter a number');
    });

    it('a text box with a rule commits once; one without (a dialog field) emits every keystroke', async () => {
        const setting = mount(MrInput, {
            props: { modelValue: 'a', type: 'text', rule: { type: 'string' } },
        });
        await type(setting, 'ab');
        await type(setting, 'abc');
        expect(setting.emitted('update:modelValue')).toBeUndefined();
        await setting.find('input').trigger('change');
        expect(setting.emitted('update:modelValue')).toEqual([['abc']]);

        const dialog = mount(MrInput, { props: { modelValue: 'a', type: 'text' } });
        await type(dialog, 'ab');
        await type(dialog, 'abc');
        expect(dialog.emitted('update:modelValue')).toEqual([['ab'], ['abc']]);
    });

    it('a re-render mid-typing keeps the text; a refused entry gives way when the stored value moves', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 5, type: 'number', min: 0, max: 10 },
        });
        const el = () => wrapper.find('input').element as HTMLInputElement;
        await type(wrapper, '8');
        await wrapper.setProps({ modelValue: 6, label: 'Gain' });
        expect(el().value).toBe('8');

        await type(wrapper, '80');
        await wrapper.find('input').trigger('change');
        await wrapper.setProps({ label: 'Gain (dB)' });
        expect(el().value).toBe('80');
        expect(reason(wrapper)).toBe('Must be between 0 and 10');
        // Another writer: the box shows what is now stored, with no reason.
        await wrapper.setProps({ modelValue: 3 });
        expect(el().value).toBe('3');
        expect(reason(wrapper)).toBeUndefined();
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('leaving the box ends the edit; a refused entry stays to say why', async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 5, type: 'number', min: 0, max: 10 },
        });
        const el = () => wrapper.find('input').element as HTMLInputElement;
        // Typed back to the text it had on focus: blur, no change event.
        await type(wrapper, '5');
        await wrapper.find('input').trigger('blur');
        await wrapper.setProps({ modelValue: 4 });
        expect(el().value).toBe('4');

        await type(wrapper, '40');
        await wrapper.find('input').trigger('change');
        await wrapper.find('input').trigger('blur');
        expect(el().value).toBe('40');
        expect(reason(wrapper)).toBe('Must be between 0 and 10');
    });

    it("a parent's error gives way while a new entry is typed", async () => {
        const wrapper = mount(MrInput, {
            props: { modelValue: 256, type: 'number', error: 'PID 256 is already used by Item 1' },
        });
        expect(reason(wrapper)).toBe('PID 256 is already used by Item 1');
        await type(wrapper, '26');
        expect(reason(wrapper)).toBeUndefined();
    });

    it('shows a unit beside the box when given one', () => {
        const wrapper = mount(MrInput, { props: { modelValue: 5, type: 'number', unit: 'min' } });
        expect(wrapper.get('[data-test="unit"]').text()).toBe('min');
        expect(
            mount(MrInput, { props: { type: 'number' } })
                .find('[data-test="unit"]')
                .exists(),
        ).toBe(false);
    });
});

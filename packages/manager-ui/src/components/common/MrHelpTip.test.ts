// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import MrHelpTip from './MrHelpTip.vue';

let wrapper: VueWrapper | null = null;

function bubble(): HTMLElement | null {
    return document.body.querySelector('[role="tooltip"]');
}

function rect(left: number, top: number, w = 12, h = 12): DOMRect {
    return { left, top, right: left + w, bottom: top + h, width: w, height: h, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
});

describe('MrHelpTip', () => {
    it('renders the help icon and no bubble until hovered', () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Some help' } });
        expect(wrapper.find('svg').exists()).toBe(true);
        expect(bubble()).toBeNull();
    });

    it('shows the text on hover and hides on leave', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Some help' } });
        await wrapper.find('[role="button"]').trigger('mouseenter');
        expect(bubble()?.textContent).toContain('Some help');
        await wrapper.find('[role="button"]').trigger('mouseleave');
        expect(bubble()).toBeNull();
    });

    it('shows on keyboard focus and closes on blur even when pinned', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Focus help' } });
        const t = wrapper.find('[role="button"]');
        await t.trigger('focus');
        expect(bubble()?.textContent).toContain('Focus help');
        await t.trigger('keydown', { key: ' ' });
        expect(t.attributes('aria-expanded')).toBe('true');
        await t.trigger('blur');
        expect(bubble()).toBeNull();
    });

    it('a click pins the bubble so mouseleave keeps it, a second click closes it', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Pinned' } });
        const t = wrapper.find('[role="button"]');
        await t.trigger('click');
        await t.trigger('mouseleave');
        expect(bubble()).not.toBeNull();
        await t.trigger('click');
        expect(bubble()).toBeNull();
    });

    it('Escape and a pointerdown elsewhere close a pinned bubble', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Pinned' } });
        const t = wrapper.find('[role="button"]');
        await t.trigger('click');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await wrapper.vm.$nextTick();
        expect(bubble()).toBeNull();

        await t.trigger('click');
        expect(bubble()).not.toBeNull();
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await wrapper.vm.$nextTick();
        expect(bubble()).toBeNull();
    });

    it('is positioned from the trigger and follows it on scroll', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Follow' } });
        const trigger = wrapper.find('[role="button"]').element as HTMLElement;
        trigger.getBoundingClientRect = () => rect(40, 100);
        await wrapper.find('[role="button"]').trigger('click');
        // Placement runs in the tick after mount; by the time the click
        // settles the bubble has been measured and made visible.
        expect(bubble()?.style.visibility).toBe('visible');
        expect(bubble()?.style.left).toBe('40px');
        expect(bubble()?.style.top).toBe('116px');

        trigger.getBoundingClientRect = () => rect(40, 30);
        document.dispatchEvent(new Event('scroll'));
        await wrapper.vm.$nextTick();
        expect(bubble()?.style.top).toBe('46px');
    });

    it('links the bubble to the trigger for screen readers', async () => {
        wrapper = mount(MrHelpTip, { props: { text: 'Announced' } });
        const t = wrapper.find('[role="button"]');
        expect(t.attributes('aria-describedby')).toBeUndefined();
        await t.trigger('mouseenter');
        expect(t.attributes('aria-describedby')).toBe(bubble()?.id);
        expect(bubble()?.id).toMatch(/^mr-help-tip-/);
    });

    it('uses the slot as a custom trigger and honours the width class', async () => {
        wrapper = mount(MrHelpTip, {
            props: { text: 'Live', width: 'w-40' },
            slots: { default: '<span class="zap">⚡</span>' },
        });
        expect(wrapper.find('.zap').exists()).toBe(true);
        expect(wrapper.find('svg').exists()).toBe(false);
        await wrapper.find('[role="button"]').trigger('mouseenter');
        expect(bubble()?.classList.contains('w-40')).toBe(true);
    });
});

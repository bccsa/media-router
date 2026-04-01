/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MrContextMenu from './MrContextMenu.vue';

describe('MrContextMenu', () => {
    const items = [
        { label: 'Restart', action: 'restart', icon: '<circle cx="12" cy="12" r="3"/>', tooltip: 'Restart the module' },
        { label: 'Settings', action: 'settings' },
        { label: '', action: '', divider: true },
        { label: 'Delete', action: 'delete', danger: true, tooltip: 'Remove permanently' },
    ];

    it('renders all non-divider items as buttons', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        const buttons = wrapper.findAll('button');
        expect(buttons).toHaveLength(3); // Restart, Settings, Delete (divider is not a button)
    });

    it('renders divider elements', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        // Dividers have border-t class
        const dividers = wrapper.findAll('div').filter((d) => d.classes().includes('border-t'));
        expect(dividers.length).toBeGreaterThanOrEqual(1);
    });

    it('renders item labels', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        expect(wrapper.text()).toContain('Restart');
        expect(wrapper.text()).toContain('Settings');
        expect(wrapper.text()).toContain('Delete');
    });

    it('renders SVG icons when provided', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        const svgs = wrapper.findAll('svg');
        expect(svgs.length).toBeGreaterThanOrEqual(1);
    });

    it('emits action on button click', async () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        const buttons = wrapper.findAll('button');
        await buttons[0].trigger('click');

        expect(wrapper.emitted('action')).toBeTruthy();
        expect(wrapper.emitted('action')![0]).toEqual(['restart']);
    });

    it('emits close after action', async () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        await wrapper.findAll('button')[0].trigger('click');
        expect(wrapper.emitted('close')).toBeTruthy();
    });

    it('does not emit action for disabled items', async () => {
        const disabledItems = [
            { label: 'Disabled', action: 'noop', disabled: true },
        ];
        const wrapper = mount(MrContextMenu, {
            props: { items: disabledItems, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        await wrapper.find('button').trigger('click');
        expect(wrapper.emitted('action')).toBeFalsy();
    });

    it('renders danger items', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        const deleteBtn = wrapper.findAll('button').find((b) => b.text().includes('Delete'));
        expect(deleteBtn).toBeDefined();
        expect(deleteBtn!.text()).toContain('Delete');
    });

    it('renders tooltip popup for items with tooltip', () => {
        const wrapper = mount(MrContextMenu, {
            props: { items, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        // Tooltip divs exist but are hidden (group-hover)
        expect(wrapper.html()).toContain('Restart the module');
        expect(wrapper.html()).toContain('Remove permanently');
    });

    it('does not render tooltip for items without tooltip', () => {
        const noTooltipItems = [
            { label: 'Plain', action: 'plain' },
        ];
        const wrapper = mount(MrContextMenu, {
            props: { items: noTooltipItems, x: 100, y: 100 },
            global: { stubs: { Teleport: true } },
        });
        // No tooltip div should exist
        const tooltipDivs = wrapper.findAll('.pointer-events-none');
        expect(tooltipDivs).toHaveLength(0);
    });

    describe('slider items', () => {
        const sliderItems = [
            {
                label: 'Volume',
                action: 'setting:volume',
                slider: { min: 0, max: 150, step: 1, value: 100, unit: '%' },
            },
            { label: '', action: '', divider: true },
            { label: 'Settings', action: 'settings' },
        ];

        it('renders slider with label and value', () => {
            const wrapper = mount(MrContextMenu, {
                props: { items: sliderItems, x: 100, y: 100 },
                global: { stubs: { Teleport: true } },
            });
            expect(wrapper.text()).toContain('Volume');
            expect(wrapper.text()).toContain('100%');
        });

        it('renders range input for slider items', () => {
            const wrapper = mount(MrContextMenu, {
                props: { items: sliderItems, x: 100, y: 100 },
                global: { stubs: { Teleport: true } },
            });
            const range = wrapper.find('input[type="range"]');
            expect(range.exists()).toBe(true);
            expect(range.attributes('min')).toBe('0');
            expect(range.attributes('max')).toBe('150');
            expect(range.attributes('step')).toBe('1');
        });

        it('emits sliderChange on input', async () => {
            const wrapper = mount(MrContextMenu, {
                props: { items: sliderItems, x: 100, y: 100 },
                global: { stubs: { Teleport: true } },
            });
            const range = wrapper.find('input[type="range"]');
            await range.setValue(75);
            await range.trigger('input');

            const emitted = wrapper.emitted('sliderChange');
            expect(emitted).toBeTruthy();
            expect(emitted![0][0]).toBe('setting:volume');
        });

        it('does not render slider as a button', () => {
            const wrapper = mount(MrContextMenu, {
                props: { items: sliderItems, x: 100, y: 100 },
                global: { stubs: { Teleport: true } },
            });
            // Only "Settings" should be a button, not "Volume"
            const buttons = wrapper.findAll('button');
            expect(buttons).toHaveLength(1);
            expect(buttons[0].text()).toContain('Settings');
        });
    });
});

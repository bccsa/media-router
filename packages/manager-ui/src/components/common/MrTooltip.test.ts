/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrTooltip from './MrTooltip.vue';

describe('MrTooltip', () => {
    it('renders slot content', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Tooltip text' },
            slots: { default: '<button>Click me</button>' },
        });
        expect(wrapper.text()).toContain('Click me');
    });

    it('renders tooltip text', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Help text here' },
            slots: { default: '<button>Btn</button>' },
        });
        expect(wrapper.html()).toContain('Help text here');
    });

    it('tooltip is hidden by default (has hidden class)', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Tooltip' },
            slots: { default: '<button>Btn</button>' },
        });
        const tooltip = wrapper.findAll('div').find((d) => d.text() === 'Tooltip');
        expect(tooltip?.classes()).toContain('hidden');
    });

    it('applies custom width class', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Wide tooltip', width: 'w-64' },
            slots: { default: '<button>Btn</button>' },
        });
        const tooltip = wrapper.findAll('div').find((d) => d.text() === 'Wide tooltip');
        expect(tooltip?.classes()).toContain('w-64');
    });

    it('uses default width when not specified', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Default width' },
            slots: { default: '<button>Btn</button>' },
        });
        const tooltip = wrapper.findAll('div').find((d) => d.text() === 'Default width');
        expect(tooltip?.classes()).toContain('w-48');
    });

    it('wraps content in a group/tb relative div', () => {
        const wrapper = mount(MrTooltip, {
            props: { text: 'Tip' },
            slots: { default: '<span>Content</span>' },
        });
        expect(wrapper.element.classList.contains('relative')).toBe(true);
    });
});

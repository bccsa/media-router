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
    inheritable: true,
};

const sceneCutField: ItemField = {
    key: 'sceneCut',
    type: 'number',
    description: 'Scene cut',
    advanced: true,
    inheritable: true,
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

describe('MrArrayItemField — boolean without a module-global (audio-transcoder opus FEC)', () => {
    const fecField: ItemField = {
        key: 'inbandFec',
        type: 'boolean',
        description: 'Opus in-band forward error correction',
        default: false,
        advanced: true,
        inheritable: false,
    };

    it('renders a REAL toggle at the schema default — no text input, no inherit affordances', () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: fecField, value: undefined },
        });
        expect(wrapper.find('[role="switch"]').exists()).toBe(true);
        expect(wrapper.find('input').exists()).toBe(false);
        expect(wrapper.find('[role="switch"]').attributes('aria-checked')).toBe('false');
        // No global to inherit → no hint, no reset button.
        expect(wrapper.text()).not.toContain('inherit');
        expect(wrapper.find('button[title="Reset to inherit global"]').exists()).toBe(false);
    });

    it('emits a real boolean when toggled', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: fecField, value: undefined },
        });
        await wrapper.find('[role="switch"]').trigger('click');
        expect(wrapper.emitted('update')?.[0]).toEqual([true]);
    });
});

describe('MrArrayItemField — boolean WITH a module-global (override semantics)', () => {
    const boolOverride: ItemField = {
        key: 'someFlag',
        type: 'boolean',
        description: 'Flag override',
        default: false,
        advanced: true,
        inheritable: true,
    };

    it('shows the inherit hint when unset and the ↺ reset once set (emits clear)', async () => {
        const unset = mount(MrArrayItemField, {
            props: { field: boolOverride, value: undefined },
        });
        expect(unset.text()).toContain('inherit');

        const set = mount(MrArrayItemField, {
            props: { field: boolOverride, value: true },
        });
        expect(set.find('[role="switch"]').attributes('aria-checked')).toBe('true');
        const reset = set.find('button[title="Reset to inherit global"]');
        expect(reset.exists()).toBe(true);
        await reset.trigger('click');
        expect(set.emitted('clear')).toBeTruthy();
    });
});

describe('MrArrayItemField — enum without a module-global (audio-transcoder frameSize)', () => {
    const frameSizeField: ItemField = {
        key: 'frameSize',
        type: 'number',
        description: 'Opus frame size',
        default: 20,
        enumValues: [2.5, 5, 10, 20, 40, 60],
        advanced: true,
        inheritable: false,
    };

    it('offers NO "Inherit (global)" option — plain enum with its own default', async () => {
        const wrapper = mount(MrArrayItemField, {
            props: { field: frameSizeField, value: 20 },
        });
        await wrapper.find('button').trigger('click');
        const items = wrapper.findAll('.cursor-pointer').map((i) => i.text());
        expect(items).not.toContain('Inherit (global)');
        expect(items).toContain('20');
    });
});

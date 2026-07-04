// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrArrayField from './MrArrayField.vue';

const schema = {
    type: 'object',
    properties: {
        name: { type: 'string', default: '', description: 'Label' },
        bitrate: { type: 'number', default: 2500, description: 'Bitrate' },
        codec: {
            type: 'string',
            enum: ['h264', 'h265'],
            'x-advanced': true,
            'x-enumLabels': { h264: 'H.264', h265: 'H.265' },
            description: 'Codec',
        },
        h264Profile: {
            type: 'string',
            enum: ['auto', 'baseline'],
            'x-advanced': true,
            'x-showWhen': 'codec=h264',
            description: 'Profile',
        },
    },
};

describe('MrArrayField', () => {
    it('seeds only primary fields on Add (advanced fields stay absent = inherit)', async () => {
        const wrapper = mount(MrArrayField, { props: { modelValue: [], schema } });
        // The header "+ Add" button.
        await wrapper.find('button').trigger('click');
        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0][0]).toEqual([{ name: '', bitrate: 2500 }]);
    });

    it('hides advanced overrides behind a collapsed section until expanded', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', bitrate: 100 }], schema },
        });
        // Advanced field labels are not rendered while collapsed.
        expect(wrapper.text()).not.toContain('Codec');
        expect(wrapper.text()).toContain('Advanced (per-encode overrides)');

        // Expand.
        const toggle = wrapper
            .findAll('button')
            .find((b) => b.text().includes('Advanced'))!;
        await toggle.trigger('click');
        expect(wrapper.text()).toContain('Codec');
    });

    it('applies item-relative x-showWhen (h264Profile hidden unless codec is h264)', async () => {
        // Rendition explicitly overrides codec to h265 → the H.264-only profile
        // field must not render even when Advanced is expanded.
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', bitrate: 100, codec: 'h265' }], schema },
        });
        const toggle = wrapper
            .findAll('button')
            .find((b) => b.text().includes('Advanced'))!;
        await toggle.trigger('click');
        expect(wrapper.text()).toContain('Codec');
        expect(wrapper.text()).not.toContain('Profile');
    });

    it('falls back to the global config for x-showWhen when the item inherits', async () => {
        // Item has no codec override → inherit; global codec is h264 → profile shows.
        const wrapper = mount(MrArrayField, {
            props: {
                modelValue: [{ name: 'A', bitrate: 100 }],
                schema,
                globalConfig: { codec: 'h264' },
            },
        });
        const toggle = wrapper
            .findAll('button')
            .find((b) => b.text().includes('Advanced'))!;
        await toggle.trigger('click');
        expect(wrapper.text()).toContain('Profile');
    });
});

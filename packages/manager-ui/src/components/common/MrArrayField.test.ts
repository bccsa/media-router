// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrArrayField from './MrArrayField.vue';
import MrSelect from './MrSelect.vue';

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

describe('MrArrayField — item-relative x-maxBy (audio-transcoder bitrate, #664)', () => {
    const boundedSchema = {
        type: 'object',
        properties: {
            codec: { type: 'string', enum: ['opus', 'aac'], default: 'opus', description: 'Codec' },
            bitrate: {
                type: 'number',
                minimum: 6,
                maximum: 510,
                default: 128,
                description: 'Bitrate',
                'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } },
            },
        },
    };

    it("caps the number input by the item's own codec", () => {
        const wrapper = mount(MrArrayField, {
            props: {
                modelValue: [
                    { codec: 'opus', bitrate: 48 },
                    { codec: 'aac', bitrate: 96 },
                ],
                schema: boundedSchema,
            },
        });
        const maxes = wrapper.findAll('input[type="number"]').map((i) => i.attributes('max'));
        expect(maxes).toEqual(['510', '320']);
    });

    it('pulls the bitrate down to the new cap when the codec changes', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ codec: 'opus', bitrate: 510 }], schema: boundedSchema },
        });
        wrapper.findComponent(MrSelect).vm.$emit('update:modelValue', 'aac');
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([
            [{ codec: 'aac', bitrate: 320 }],
        ]);
    });
});

describe("MrArrayField — item-relative x-maxFrom, by the manager's rule (B-103)", () => {
    const rangedSchema = {
        type: 'object',
        properties: {
            levelMax: { type: 'number', enum: [100, 150, 500], description: 'Range' },
            level: {
                type: 'number',
                minimum: 0,
                maximum: 150,
                description: 'Level',
                'x-maxFrom': 'levelMax',
            },
        },
    };

    it("caps the number input by the item's own source, else the module's", () => {
        const wrapper = mount(MrArrayField, {
            props: {
                modelValue: [{ levelMax: 500, level: 300 }, { level: 80 }],
                schema: rangedSchema,
                globalConfig: { levelMax: 100 },
            },
        });
        const maxes = wrapper.findAll('input[type="number"]').map((i) => i.attributes('max'));
        expect(maxes).toEqual(['500', '100']);
    });

    it('pulls the level down to its source when that comes down', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ levelMax: 500, level: 300 }], schema: rangedSchema },
        });
        wrapper.findComponent(MrSelect).vm.$emit('update:modelValue', 150);
        await wrapper.vm.$nextTick();
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([
            [{ levelMax: 150, level: 150 }],
        ]);
    });
});

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
        const toggle = wrapper.findAll('button').find((b) => b.text().includes('Advanced'))!;
        await toggle.trigger('click');
        expect(wrapper.text()).toContain('Codec');
    });

    it('applies item-relative x-showWhen (h264Profile hidden unless codec is h264)', async () => {
        // Rendition explicitly overrides codec to h265 → the H.264-only profile
        // field must not render even when Advanced is expanded.
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', bitrate: 100, codec: 'h265' }], schema },
        });
        const toggle = wrapper.findAll('button').find((b) => b.text().includes('Advanced'))!;
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
        const toggle = wrapper.findAll('button').find((b) => b.text().includes('Advanced'))!;
        await toggle.trigger('click');
        expect(wrapper.text()).toContain('Profile');
    });
});

describe('MrArrayField — x-unique / x-autoAssign (muxer input PID)', () => {
    const pidSchema = {
        type: 'object',
        properties: {
            name: { type: 'string', default: '' },
            pid: {
                type: 'number',
                title: 'PID',
                minimum: 32,
                maximum: 8190,
                'x-unique': true,
                'x-reserved': [496, 4096],
                'x-autoAssign': { start: 256, step: 8 },
            },
        },
    };

    it('Add seeds the next free PID, skipping every sibling value', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', pid: 256 }, { name: 'B', pid: 272 }], schema: pidSchema },
        });
        await wrapper.find('button').trigger('click');
        expect(wrapper.emitted('update:modelValue')![0][0]).toEqual([
            { name: 'A', pid: 256 },
            { name: 'B', pid: 272 },
            { name: '', pid: 264 },
        ]);
    });

    it('holds a duplicate edit back with an error and never emits it', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', pid: 256 }, { name: 'B', pid: 264 }], schema: pidSchema },
        });
        const input = wrapper.findAll('input[type="number"]')[1];
        await input.setValue('256');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('PID 256 is already used by Item 1');

        await input.setValue('300');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([
            [{ name: 'A', pid: 256 }, { name: 'B', pid: 300 }],
        ]);
        expect(wrapper.text()).not.toContain('already used');
    });

    it('checks a duplicate when the entry commits, never per keystroke (B-104)', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', pid: 256 }, { name: 'B', pid: 2560 }], schema: pidSchema },
        });
        const input = wrapper.findAll('input[type="number"]')[1];
        // "256" on the way to "2568" is item 1's PID: no error shown, nothing written.
        for (const typed of ['2', '25', '256']) {
            (input.element as HTMLInputElement).value = typed;
            await input.trigger('input');
        }
        expect(wrapper.text()).not.toContain('already used');
        (input.element as HTMLInputElement).value = '2568';
        await input.trigger('input');
        await input.trigger('change');
        expect(wrapper.emitted('update:modelValue')).toEqual([
            [[{ name: 'A', pid: 256 }, { name: 'B', pid: 2568 }]],
        ]);
    });

    it('drops a rejected draft once the list changes, so a freed PID can be typed again', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', pid: 256 }, { name: 'B', pid: 264 }], schema: pidSchema },
        });
        await wrapper.findAll('input[type="number"]')[1].setValue('256');
        expect(wrapper.text()).toContain('already used by Item 1');
        // Item 1 moves off 256 (here: the parent echoes a new list).
        await wrapper.setProps({ modelValue: [{ name: 'A', pid: 300 }, { name: 'B', pid: 264 }] });
        expect(wrapper.text()).not.toContain('already used');
        const input = wrapper.findAll('input[type="number"]')[1];
        expect((input.element as HTMLInputElement).value).toBe('264');
        await input.setValue('256');
        expect(wrapper.emitted('update:modelValue')!.at(-1)).toEqual([
            [{ name: 'A', pid: 300 }, { name: 'B', pid: 256 }],
        ]);
    });

    it('shows unassigned (blank / 0) PIDs as the values the engine seeds, never as duplicates', () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ pid: 0 }, { pid: 256 }, {}], schema: pidSchema },
        });
        const values = wrapper
            .findAll('input[type="number"]')
            .map((i) => (i.element as HTMLInputElement).value);
        expect(values).toEqual(['264', '256', '272']);
        expect(wrapper.text()).not.toContain('already used');
    });

    it('checks x-unique on advanced fields too', async () => {
        const advSchema = {
            type: 'object',
            properties: {
                id: { type: 'number', title: 'ID', 'x-advanced': true, 'x-unique': true },
            },
        };
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ id: 5 }, { id: 6 }], schema: advSchema },
        });
        for (const t of wrapper.findAll('button').filter((b) => b.text().includes('Advanced'))) {
            await t.trigger('click');
        }
        await wrapper.findAll('input[type="number"]')[1].setValue('5');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('ID 5 is already used by Item 1');
    });

    it('rejects a reserved PID', async () => {
        const wrapper = mount(MrArrayField, {
            props: { modelValue: [{ name: 'A', pid: 256 }], schema: pidSchema },
        });
        await wrapper.find('input[type="number"]').setValue('4096');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper.text()).toContain('PID 4096 is reserved');
    });
});

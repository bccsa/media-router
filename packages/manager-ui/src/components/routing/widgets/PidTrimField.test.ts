// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PidTrimField from './PidTrimField.vue';
import type { FormField } from '@/composables/useModuleSettingsForm';

/** The field the form builds from WI-P1-9's `pidTrimsMs` schema. */
const FIELD: FormField = {
    key: 'pidTrimsMs',
    type: 'object',
    label: 'Per-PID Trim',
    description: '',
    defaultValue: {},
    liveUpdatable: true,
    optionsFrom: 'pids',
    widget: 'pidTrim',
    unit: 'ms',
    additionalProperties: { type: 'number', minimum: -2000, maximum: 2000 },
};

/** The `pids` field options as the ingest reporter publishes them. */
const PIDS = [
    { value: '256', label: '0x0100 H.264 video' },
    { value: '257', label: '0x0101 AAC audio' },
];

function mountField(props: Record<string, unknown> = {}) {
    return mount(PidTrimField, { props: { field: FIELD, options: PIDS, ...props } });
}

const row = (wrapper: ReturnType<typeof mountField>, pid: string) =>
    wrapper.get(`[data-pid="${pid}"]`);
const trimInput = (wrapper: ReturnType<typeof mountField>, pid: string) =>
    row(wrapper, pid).get('input');
const emitted = (wrapper: ReturnType<typeof mountField>) =>
    (wrapper.emitted('update:modelValue') ?? []).map(([map]) => map);

describe('PidTrimField', () => {
    it('renders one row per detected PID: hex, type, trim and the shift O + trim', () => {
        const wrapper = mountField({ modelValue: { '257': 120 }, offsetMs: -40 });

        expect(wrapper.findAll('[data-pid]').map((r) => r.attributes('data-pid'))).toEqual([
            '256',
            '257',
        ]);
        expect(row(wrapper, '256').text()).toContain('0x0100');
        // The label's leading hex is not repeated on the type line.
        expect(row(wrapper, '256').get('[data-test="type"]').text()).toBe('H.264 video');
        expect(row(wrapper, '257').get('[data-test="type"]').text()).toBe('AAC audio');
        expect((trimInput(wrapper, '256').element as HTMLInputElement).value).toBe('0');
        expect((trimInput(wrapper, '257').element as HTMLInputElement).value).toBe('120');
        expect(trimInput(wrapper, '257').attributes('aria-label')).toBe('Trim for PID 0x0101');
        expect(row(wrapper, '256').get('[data-test="shift"]').text()).toBe('-40');
        expect(row(wrapper, '257').get('[data-test="shift"]').text()).toBe('80');
        expect(wrapper.text()).toContain('Trim (ms)');
        expect(wrapper.text()).toContain('Shift (ms)');
        expect(wrapper.text()).toContain('Shift = Ingest Offset (-40 ms) + trim');
    });

    it('with no Ingest Offset set, the shift is the trim', () => {
        const wrapper = mountField({ modelValue: { '257': 120 } });
        expect(row(wrapper, '257').get('[data-test="shift"]').text()).toBe('120');
        expect(wrapper.text()).toContain('Shift = Ingest Offset (0 ms) + trim');
    });

    it('bounds the inputs to the schema: -2000..2000 ms, step 1', () => {
        const input = trimInput(mountField(), '256');
        expect(input.attributes('min')).toBe('-2000');
        expect(input.attributes('max')).toBe('2000');
        expect(input.attributes('step')).toBe('1');
        expect(input.attributes('disabled')).toBeUndefined();
    });

    it('clamps a typed trim to ±2000 ms in whole ms', async () => {
        const wrapper = mountField({ modelValue: {} });

        await trimInput(wrapper, '256').setValue('2500');
        await trimInput(wrapper, '257').setValue('-9999');
        await trimInput(wrapper, '257').setValue('12.6');

        expect(emitted(wrapper)).toEqual([{ '256': 2000 }, { '257': -2000 }, { '257': 13 }]);
        expect((trimInput(wrapper, '256').element as HTMLInputElement).value).toBe('2000');
    });

    it('a clamp onto the stored trim emits nothing but puts the bound back in the box', async () => {
        const wrapper = mountField({ modelValue: { '256': 2000 } });

        await trimInput(wrapper, '256').setValue('3000');

        expect(emitted(wrapper)).toEqual([]);
        expect((trimInput(wrapper, '256').element as HTMLInputElement).value).toBe('2000');
    });

    it('keeps a trim whose PID left the stream: greyed, "not in stream", in every emit', async () => {
        const wrapper = mountField({ modelValue: { '4096': -8, '257': 120, '300': 15 } });

        // Detected rows first, in the plugin's order, then stale ones by PID.
        expect(wrapper.findAll('[data-pid]').map((r) => r.attributes('data-pid'))).toEqual([
            '256',
            '257',
            '300',
            '4096',
        ]);
        const stale = row(wrapper, '300');
        expect(stale.text()).toContain('0x012C');
        expect(stale.text()).toContain('not in stream');
        expect(stale.classes()).toContain('opacity-50');
        expect(row(wrapper, '257').classes()).not.toContain('opacity-50');

        await trimInput(wrapper, '256').setValue('30');

        expect(emitted(wrapper)).toEqual([{ '256': 30, '257': 120, '300': 15, '4096': -8 }]);
    });

    it('a stale trim can be cleared, which drops it from the map', async () => {
        const wrapper = mountField({ modelValue: { '257': 120, '300': 15 } });

        await trimInput(wrapper, '300').setValue('0');

        expect(emitted(wrapper)).toEqual([{ '257': 120 }]);
    });

    it('emits the whole map on edit, and a zero or cleared trim removes its key', async () => {
        const wrapper = mountField({ modelValue: { '256': 10, '257': 120 } });

        await trimInput(wrapper, '257').setValue('-35');
        await trimInput(wrapper, '257').setValue('0');
        await trimInput(wrapper, '256').setValue('');

        expect(emitted(wrapper)).toEqual([
            { '256': 10, '257': -35 },
            { '256': 10 },
            { '257': 120 },
        ]);
    });

    it('commits on change, never per keystroke', async () => {
        const wrapper = mountField({ modelValue: {} });
        const input = trimInput(wrapper, '256');

        (input.element as HTMLInputElement).value = '20';
        await input.trigger('input');
        expect(emitted(wrapper)).toEqual([]);

        await input.trigger('change');
        expect(emitted(wrapper)).toEqual([{ '256': 20 }]);
    });

    it('shows "Waiting for the stream\'s PMT" until the plugin publishes PIDs', () => {
        const empty = mountField({ options: [], modelValue: {} });
        expect(empty.text()).toContain("Waiting for the stream's PMT");
        expect(empty.findAll('[data-pid]')).toHaveLength(0);

        // Stored trims still show, so they are not lost while the PMT is pending.
        const stored = mountField({ options: [], modelValue: { '257': 120 } });
        expect(stored.text()).toContain("Waiting for the stream's PMT");
        expect(row(stored, '257').text()).toContain('not in stream');

        expect(mountField().text()).not.toContain('Waiting');
    });

    it('disables every trim and shows the reason beside them', async () => {
        const reason = 'In Trust mode: switch the ingest to Restamp to set an offset';
        const wrapper = mountField({
            modelValue: { '257': 120, '300': 15 },
            disabledReason: reason,
        });

        expect(wrapper.get('[data-test="disabled-reason"]').text()).toBe(reason);
        const inputs = wrapper.findAll('input');
        expect(inputs).toHaveLength(3);
        for (const input of inputs) {
            expect(input.attributes('disabled')).toBeDefined();
            expect(input.attributes('title')).toBe(reason);
        }
        for (const r of wrapper.findAll('[data-pid]')) expect(r.classes()).toContain('opacity-50');

        await trimInput(wrapper, '256').setValue('30');
        expect(emitted(wrapper)).toEqual([]);
        expect(mountField().find('[data-test="disabled-reason"]').exists()).toBe(false);
    });

    it('treats a stored value that is not a map of numbers as no trims', async () => {
        for (const modelValue of [undefined, null, [1, 2], 'x', 5]) {
            const wrapper = mountField({ modelValue });
            expect(wrapper.findAll('[data-pid]')).toHaveLength(2);
            expect((trimInput(wrapper, '257').element as HTMLInputElement).value).toBe('0');
        }

        const wrapper = mountField({ modelValue: { '256': '40', '257': 50, '258': null } });
        expect((trimInput(wrapper, '256').element as HTMLInputElement).value).toBe('0');
        await trimInput(wrapper, '257').setValue('60');
        expect(emitted(wrapper)).toEqual([{ '257': 60 }]);
    });

    it('drops focus on wheel so scrolling the panel cannot edit a trim', async () => {
        const wrapper = mount(PidTrimField, {
            props: { field: FIELD, options: PIDS, modelValue: {} },
            attachTo: document.body,
        });
        const el = trimInput(wrapper, '256').element as HTMLInputElement;
        el.focus();
        expect(document.activeElement).toBe(el);

        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));

        expect(document.activeElement).not.toBe(el);
        wrapper.unmount();
    });
});

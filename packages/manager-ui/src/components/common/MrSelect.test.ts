// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrSelect from './MrSelect.vue';

const options = [
    { value: 'listener', label: 'listener' },
    { value: 'caller', label: 'caller' },
    { value: 'rendezvous', label: 'rendezvous' },
];

describe('MrSelect', () => {
    it('renders with selected value', () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
        });
        expect(wrapper.text()).toContain('listener');
    });

    it('opens dropdown on click', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
        });
        // Dropdown should not be visible initially
        expect(wrapper.findAll('.cursor-pointer').length).toBe(0);

        // Click trigger button
        await wrapper.find('button').trigger('click');

        // Dropdown should now show all options
        const items = wrapper.findAll('.cursor-pointer');
        expect(items.length).toBe(3);
        expect(items[0].text()).toBe('listener');
        expect(items[1].text()).toBe('caller');
        expect(items[2].text()).toBe('rendezvous');
    });

    it('emits update:modelValue when clicking a different option', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
        });

        // Open dropdown
        await wrapper.find('button').trigger('click');

        // Click "caller" option
        const items = wrapper.findAll('.cursor-pointer');
        await items[1].trigger('click');

        // Should emit the new value
        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0]).toEqual(['caller']);
    });

    it('emits update:modelValue when clicking the currently selected option', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
        });

        await wrapper.find('button').trigger('click');

        // Click the already-selected "listener" option
        const items = wrapper.findAll('.cursor-pointer');
        await items[0].trigger('click');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0]).toEqual(['listener']);
    });

    it('closes dropdown after selection', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
        });

        await wrapper.find('button').trigger('click');
        expect(wrapper.findAll('.cursor-pointer').length).toBe(3);

        // Select an option
        await wrapper.findAll('.cursor-pointer')[1].trigger('click');

        // Dropdown should be closed
        expect(wrapper.findAll('.cursor-pointer').length).toBe(0);
    });

    it('shows placeholder when no value selected', () => {
        const wrapper = mount(MrSelect, {
            props: { options, placeholder: 'Choose...' },
        });
        expect(wrapper.text()).toContain('Choose...');
    });

    it('disables button when disabled prop is true', () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options, disabled: true },
        });
        expect(wrapper.find('button').attributes('disabled')).toBeDefined();
    });

    it('does not open when disabled', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options, disabled: true },
        });
        await wrapper.find('button').trigger('click');
        expect(wrapper.findAll('.cursor-pointer').length).toBe(0);
    });

    it('filters options when searchable', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options, searchable: true },
        });

        await wrapper.find('button').trigger('click');

        // Should show search input
        const searchInput = wrapper.find('input[type="text"]');
        expect(searchInput.exists()).toBe(true);

        // Type to filter
        await searchInput.setValue('call');

        const items = wrapper.findAll('.cursor-pointer');
        expect(items.length).toBe(1);
        expect(items[0].text()).toBe('caller');
    });

    it('closes dropdown on click outside', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
            attachTo: document.body,
        });

        // Open
        await wrapper.find('button').trigger('click');
        expect(wrapper.findAll('.cursor-pointer').length).toBe(3);

        // Click outside (on the document body)
        await new Promise((r) => setTimeout(r, 10)); // wait for listener to attach
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await wrapper.vm.$nextTick();

        // Dropdown should be closed
        expect(wrapper.findAll('.cursor-pointer').length).toBe(0);

        wrapper.unmount();
    });

    it('selecting option works without Teleport overlay interference', async () => {
        const wrapper = mount(MrSelect, {
            props: { modelValue: 'listener', options },
            attachTo: document.body,
        });

        await wrapper.find('button').trigger('click');
        expect(wrapper.findAll('.cursor-pointer').length).toBe(3);

        // Click "caller"
        await wrapper.findAll('.cursor-pointer')[1].trigger('click');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0]).toEqual(['caller']);
        expect(wrapper.findAll('.cursor-pointer').length).toBe(0);

        wrapper.unmount();
    });

    it('handles number values correctly', async () => {
        const numOptions = [
            { value: 48000, label: '48000' },
            { value: 44100, label: '44100' },
        ];
        const wrapper = mount(MrSelect, {
            props: { modelValue: 48000, options: numOptions },
        });

        await wrapper.find('button').trigger('click');
        await wrapper.findAll('.cursor-pointer')[1].trigger('click');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted).toBeTruthy();
        expect(emitted![0]).toEqual([44100]);
    });
});

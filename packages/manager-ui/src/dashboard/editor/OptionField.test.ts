// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import OptionField from './OptionField.vue';

describe('OptionField', () => {
    it('a number option commits at Enter or on leaving the box; cleared, it is its default again (B-104)', async () => {
        const w = mount(OptionField, {
            props: { def: { key: 'labelSize', label: 'Label size', kind: 'number' }, value: 14 },
        });
        const box = w.get('input');
        (box.element as HTMLInputElement).value = '1';
        await box.trigger('input');
        expect(w.emitted('change')).toBeUndefined();

        await box.setValue('18');
        await box.setValue('');
        expect(w.emitted('change')).toEqual([[18], [undefined]]);
    });

    it('a text option follows the typing: the editor draft, published by its Save', async () => {
        const w = mount(OptionField, {
            props: { def: { key: 'label', label: 'Label', kind: 'text' }, value: '' },
        });
        const box = w.get('input');
        for (const typed of ['M', 'Mi', 'Mic']) {
            (box.element as HTMLInputElement).value = typed;
            await box.trigger('input');
        }
        expect(w.emitted('change')).toEqual([['M'], ['Mi'], ['Mic']]);
    });
});

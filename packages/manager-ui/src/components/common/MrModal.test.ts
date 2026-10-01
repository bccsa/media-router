/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MrModal from './MrModal.vue';

const esc = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

describe('MrModal', () => {
    it('Escape closes only the newest of stacked modals', () => {
        const outer = mount(MrModal, { props: { title: 'Outer' }, attachTo: document.body });
        const inner = mount(MrModal, { props: { title: 'Inner' }, attachTo: document.body });
        esc();
        expect(inner.emitted('close')).toHaveLength(1);
        expect(outer.emitted('close')).toBeUndefined();
        inner.unmount();
        esc();
        expect(outer.emitted('close')).toHaveLength(1);
        outer.unmount();
    });

    it('takes a max-width class', () => {
        const w = mount(MrModal, { props: { title: 'T', width: 'max-w-3xl' }, attachTo: document.body });
        expect(document.body.querySelector('.max-w-3xl')).not.toBeNull();
        expect(document.body.querySelector('.max-w-md')).toBeNull();
        w.unmount();
    });
});

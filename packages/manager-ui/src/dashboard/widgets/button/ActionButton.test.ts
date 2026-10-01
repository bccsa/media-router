/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionButton from './ActionButton.vue';

const base = { label: 'Go', options: {}, interactive: true } as any;

describe('ActionButton', () => {
    it('carries the whole failure for the hover view', () => {
        const msg = 'Step 2: /modules/audio-output-302m-x/settings/volume is not writable';
        const w = mount(ActionButton, { props: { ...base, failure: msg } });
        expect(w.find('.bt-fail-full').text()).toBe(msg);
    });

    it('shows no failure view while running', () => {
        const w = mount(ActionButton, { props: { ...base, failure: 'x', progress: '1/3' } });
        expect(w.find('.bt-fail-full').exists()).toBe(false);
    });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LatchButton from './LatchButton.vue';

const widget = { id: 'w', type: 'latch', x: 0, y: 0, w: 2, h: 2, bind: '/modules/m1/settings/audioEnabled' };
const desc = { access: 'write' as const, type: 'boolean' };
const mountAt = (value: boolean, options: Record<string, unknown> = {}, interactive = true) =>
    mount(LatchButton, { props: { widget, value, desc, interactive, label: 'Mic', options } });

describe('LatchButton (push on, push off)', () => {
    it('each press writes the opposite of the stored value', async () => {
        const on = mountAt(true);
        await on.find('button').trigger('click');
        expect(on.emitted('write')).toEqual([[false]]);
        const off = mountAt(false);
        await off.find('button').trigger('click');
        expect(off.emitted('write')).toEqual([[true]]);
    });

    it('lights on true by default, on false for a mute on "Audio Enabled"', () => {
        expect(mountAt(true).find('.tb-lit').exists()).toBe(true);
        expect(mountAt(false).find('.tb-lit').exists()).toBe(false);
        const mute = { litWhen: 'false', litText: 'MUTED', unlitText: 'MUTE' };
        expect(mountAt(false, mute).find('.tb-lit').text()).toBe('MUTED');
        expect(mountAt(true, mute).find('.tb-lit').exists()).toBe(false);
        expect(mountAt(true, mute).text()).toBe('MUTE');
    });

    it('writes nothing when it takes no input', async () => {
        const w = mountAt(true, {}, false);
        await w.find('button').trigger('click');
        expect(w.emitted('write')).toBeUndefined();
    });
});

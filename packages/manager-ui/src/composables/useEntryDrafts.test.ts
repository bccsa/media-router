// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { defineComponent } from 'vue';
import { mount } from '@vue/test-utils';
import { useEntryDrafts } from './useEntryDrafts';

type Drafts = ReturnType<typeof useEntryDrafts>;

function mountDrafts() {
    let api!: Drafts;
    const wrapper = mount(
        defineComponent({
            setup() {
                api = useEntryDrafts();
                return () => null;
            },
        }),
    );
    return { api, wrapper };
}

/** An event from a box holding `text`, as the browser delivers it. */
function eventFrom(text: string): Event {
    const el = document.createElement('input');
    el.value = text;
    return { target: el } as unknown as Event;
}

const RULE = { type: 'number', min: 0, max: 10 };

describe('useEntryDrafts (B-104)', () => {
    it('holds typing per box, returns a valid change once, nothing for an unchanged one', () => {
        const { api } = mountDrafts();
        api.onInput('a', eventFrom('7'));
        expect(api.shown('a', 5)).toBe('7');
        expect(api.shown('b', 5)).toBe(5);
        expect(api.typing('a', 5)).toBe(true);

        expect(api.commit('a', eventFrom('7'), 5, RULE)).toEqual({ value: 7 });
        expect(api.shown('a', 7)).toBe(7);
        expect(api.commit('a', eventFrom('7'), 7, RULE)).toBeUndefined();
    });

    it('keeps a refused entry with its reason until the stored value moves under it', () => {
        const { api } = mountDrafts();
        expect(api.commit('a', eventFrom('70'), 5, RULE)).toBeUndefined();
        expect(api.shown('a', 5)).toBe('70');
        expect(api.reason('a', 5)).toBe('Must be between 0 and 10');
        expect(api.typing('a', 5)).toBe(false);
        // Leaving the box keeps it, to say why.
        api.onBlur('a', { target: document.createElement('input') } as unknown as FocusEvent);
        expect(api.reason('a', 5)).toBe('Must be between 0 and 10');
        // Another writer stores 6: the box shows it.
        expect(api.shown('a', 6)).toBe(6);
        expect(api.reason('a', 6)).toBeUndefined();
    });

    it('formats the stored value only when no draft is shown', () => {
        const { api } = mountDrafts();
        expect(api.shown('a', 75.4, '75')).toBe('75');
        api.onInput('a', eventFrom('80'));
        expect(api.shown('a', 75.4, '75')).toBe('80');
    });

    it('writes nothing once its owner is unmounting: a removed box can still fire change', () => {
        const { api, wrapper } = mountDrafts();
        api.onInput('a', eventFrom('8'));
        wrapper.unmount();
        expect(api.commit('a', eventFrom('8'), 5, RULE)).toBeUndefined();
    });
});

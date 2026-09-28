// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { VueFlow } from '@vue-flow/core';
import { panActivationKey } from '@/utils/panKey';

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

// Vue Flow's pan key listens on document, so any input on the page is affected.
function mountFlow(panKey?: typeof panActivationKey) {
    const App = defineComponent({
        setup: () => () =>
            h('div', [
                h('input'),
                h(VueFlow, { nodes: [], edges: [], panActivationKeyCode: panKey }),
            ]),
    });
    return mount(App, { attachTo: document.body });
}

function shiftSpace(el: Element): KeyboardEvent {
    const e = new KeyboardEvent('keydown', {
        code: 'Space',
        key: ' ',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
    });
    el.dispatchEvent(e);
    return e;
}

describe('Vue Flow pan key vs text inputs (#728)', () => {
    // Canary: if this starts failing, Vue Flow fixed it upstream and the override can go.
    it('default pan key swallows Shift+Space in an input', () => {
        const w = mountFlow();
        expect(shiftSpace(w.get('input').element).defaultPrevented).toBe(true);
        w.unmount();
    });

    it('panActivationKey lets Shift+Space through to the input', () => {
        const w = mountFlow(panActivationKey);
        expect(shiftSpace(w.get('input').element).defaultPrevented).toBe(false);
        w.unmount();
    });

    it('panActivationKey still claims Space on the canvas', () => {
        const w = mountFlow(panActivationKey);
        expect(shiftSpace(w.get('.vue-flow').element).defaultPrevented).toBe(true);
        w.unmount();
    });
});

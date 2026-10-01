/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import LinearControl from './LinearControl.vue';
import fader from '../fader/index';
import slider from '../slider/index';

const widget = { id: 'w', type: 'fader', x: 0, y: 0, w: 2, h: 6, bind: '/modules/m1/settings/volume' };
const desc = { access: 'write' as const, type: 'number', min: 0, max: 150, step: 1 };

/** A fader, as its definition builds it: the shared control with the fader's props (upright). */
function setup(value = 100) {
    const onWrite = vi.fn();
    const root = mount(fader.component, { props: { ...fader.componentProps, widget, value, desc, interactive: true, label: 'Vol', options: { showValue: true }, onWrite } });
    const track = root.find('.lc-track').element as HTMLElement;
    track.getBoundingClientRect = () => ({ height: 150, width: 20, top: 0, left: 0, bottom: 150, right: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const at = (type: string, clientY: number) => pointer(root.find('.lc').element, type, clientY);
    return { wrapper: root.findComponent(LinearControl), at, onWrite };
}

/** jsdom has no PointerEvent: a MouseEvent with the coordinates and a pointer id does. */
async function pointer(el: Element, type: string, clientY: number) {
    const e = new MouseEvent(type, { clientX: 5, clientY, bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    el.dispatchEvent(e);
    await Promise.resolve();
}

describe('LinearControl (grab and drag)', () => {
    afterEach(() => vi.useRealTimers());

    it('a touch alone changes nothing: no write, wherever it lands', async () => {
        const { wrapper, at } = setup();
        await at('pointerdown', 140);
        await at('pointerup', 140);
        expect(wrapper.emitted('write')).toBeUndefined();
    });

    it('a drag moves the value by the travel, from where it was', async () => {
        vi.useFakeTimers();
        const { wrapper, at, onWrite } = setup(100);
        await at('pointerdown', 75);
        await at('pointermove', 105); // 30 px down of 150 px = -30 of 150
        await at('pointerup', 105);
        const writes = (wrapper.emitted('write') ?? []).map(([v]) => v);
        expect(writes.at(-1)).toBe(70);
        expect(writes.every((v) => v === 70)).toBe(true);
        // The host listens on the definition's component: the write reaches it.
        expect(onWrite).toHaveBeenLastCalledWith(70);
    });

    it('takes no input when not interactive', async () => {
        const wrapper = mount(LinearControl, { props: { widget, value: 100, desc, interactive: false, label: 'Vol', options: {} } });
        const el = wrapper.find('.lc').element;
        await pointer(el, 'pointerdown', 10);
        await pointer(el, 'pointermove', 100);
        await pointer(el, 'pointerup', 100);
        expect(wrapper.emitted('write')).toBeUndefined();
    });

    it('a slider moves along x', async () => {
        vi.useFakeTimers();
        const wrapper = mount(slider.component, { props: { widget: { ...widget, type: 'slider' }, value: 0, desc, interactive: true, label: 'Vol', options: {} } });
        const track = wrapper.find('.lc-track').element as HTMLElement;
        track.getBoundingClientRect = () => ({ height: 20, width: 150, top: 0, left: 0, bottom: 20, right: 150, x: 0, y: 0, toJSON() {} }) as DOMRect;
        const el = wrapper.find('.lc').element;
        const at = async (type: string, clientX: number, clientY: number) => {
            const e = new MouseEvent(type, { clientX, clientY, bubbles: true });
            Object.defineProperty(e, 'pointerId', { value: 1 });
            el.dispatchEvent(e);
            await Promise.resolve();
        };
        await at('pointerdown', 10, 10);
        await at('pointermove', 10, 60);
        expect(wrapper.emitted('write')).toBeUndefined();
        await at('pointermove', 40, 60);
        await at('pointerup', 40, 60);
        vi.runAllTimers();
        expect(wrapper.emitted('write')?.at(-1)).toEqual([30]);
    });

    it('takes keys like a slider: a step, ten steps, the ends', async () => {
        const { wrapper } = setup(100);
        const el = wrapper.find('.lc');
        expect(el.attributes()).toMatchObject({ role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': '150', 'aria-valuenow': '100' });
        for (const key of ['ArrowUp', 'ArrowLeft', 'PageUp', 'Home', 'End']) await el.trigger('keydown', { key });
        expect(wrapper.emitted('write')?.map(([v]) => v)).toEqual([101, 99, 110, 0, 150]);
    });

    it('without a range from /meta it takes no input and says so', async () => {
        const wrapper = mount(LinearControl, { props: { widget, value: 5, desc: { access: 'write' as const, type: 'number' }, interactive: true, label: 'Vol', options: {} } });
        expect(wrapper.find('.lc-value').text()).toBe('No range');
        await wrapper.find('.lc').trigger('keydown', { key: 'ArrowUp' });
        await pointer(wrapper.find('.lc').element, 'pointerdown', 10);
        await pointer(wrapper.find('.lc').element, 'pointermove', 100);
        expect(wrapper.emitted('write')).toBeUndefined();
    });

    it('a value that asks for it (x-debounceMs) is written only once the drag rests, and on release', async () => {
        vi.useFakeTimers();
        const wrapper = mount(LinearControl, {
            props: { widget, value: 100, desc: { ...desc, debounceMs: 300 }, interactive: true, label: 'Bitrate', options: {}, vertical: true },
        });
        const track = wrapper.find('.lc-track').element as HTMLElement;
        track.getBoundingClientRect = () => ({ height: 150, width: 20, top: 0, left: 0, bottom: 150, right: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;
        const el = wrapper.find('.lc').element;
        await pointer(el, 'pointerdown', 75);
        for (const y of [80, 85, 90]) {
            await pointer(el, 'pointermove', y);
            vi.advanceTimersByTime(100);
        }
        expect(wrapper.emitted('write')).toBeUndefined();
        vi.advanceTimersByTime(300);
        expect(wrapper.emitted('write')).toEqual([[85]]);
        await pointer(el, 'pointermove', 105);
        await pointer(el, 'pointerup', 105);
        expect(wrapper.emitted('write')).toEqual([[85], [70]]);
    });
});

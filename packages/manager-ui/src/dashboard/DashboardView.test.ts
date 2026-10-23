/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import DashboardView from './DashboardView.vue';
import type { DashboardSource } from './source';

const VOL_A = '/modules/a/settings/volume';
const VOL_B = '/modules/b/settings/volume';
const DESC = { access: 'write', type: 'number', min: 0, max: 150, step: 1 };

function fakeSource() {
    const data = reactive<Record<string, unknown>>({
        [VOL_A]: 100,
        [`/meta${VOL_A}`]: DESC,
        '/modules/a/pluginId': 'audio-mixer',
        [VOL_B]: 40,
        [`/meta${VOL_B}`]: DESC,
        '/modules/b/pluginId': 'audio-mixer',
    });
    const write = vi.fn(async (_ops: Array<{ path: string; value: unknown }>) => ({
        rejected: [],
    }));
    const source = {
        prefix: '',
        connected: ref(true),
        get: (p: string) => data[p],
        loaded: () => true,
        subscribe: () => () => {},
        write,
        call: async () => ({}),
        close() {},
    } as unknown as DashboardSource;
    return { source, write };
}

/** A dashboard holding one fader, widget id `w1`, bound to `bind`: a copy keeps the id. */
const withFader = (bind: string) => ({
    name: 'Desk',
    cols: 12,
    rows: 12,
    scroll: false,
    zoom: false,
    locked: false,
    theme: 'dark',
    widgets: [{ id: 'w1', type: 'fader', x: 0, y: 0, w: 2, h: 6, bind }],
});

/** jsdom has no PointerEvent: a MouseEvent with the coordinates and a pointer id does. */
async function pointer(el: Element, type: string, clientY: number) {
    const e = new MouseEvent(type, { clientX: 5, clientY, bubbles: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    el.dispatchEvent(e);
    await Promise.resolve();
}

describe('DashboardView: a held drag value goes to the value it was made on (B-106)', () => {
    afterEach(() => vi.useRealTimers());

    it("the widget bound elsewhere mid-drag (another dashboard's copy of it): the held value goes to A at once, B gets nothing", async () => {
        vi.useFakeTimers();
        const { source, write } = fakeSource();
        const view = mount(DashboardView, {
            props: { dashboard: withFader(VOL_A) as never, source },
        });
        const track = view.find('.lc-track').element as HTMLElement;
        track.getBoundingClientRect = () =>
            ({
                height: 150,
                width: 20,
                top: 0,
                left: 0,
                bottom: 150,
                right: 20,
                x: 0,
                y: 0,
                toJSON() {},
            }) as DOMRect;
        const lc = view.find('.lc').element;

        await pointer(lc, 'pointerdown', 75);
        await pointer(lc, 'pointermove', 85); // 90: written at once
        await pointer(lc, 'pointermove', 95); // 80: held, inside the 100 ms window
        expect(write.mock.calls.map(([ops]) => ops[0])).toEqual([
            { op: 'replace', path: VOL_A, value: 90 },
        ]);
        await view.setProps({ dashboard: withFader(VOL_B) as never });
        await Promise.resolve();

        expect(write.mock.calls.map(([ops]) => ops[0])).toEqual([
            { op: 'replace', path: VOL_A, value: 90 },
            { op: 'replace', path: VOL_A, value: 80 },
        ]);
        vi.advanceTimersByTime(2000);
        expect(write.mock.calls.flatMap(([ops]) => ops).filter((op) => op.path === VOL_B)).toEqual(
            [],
        );
        expect(write).toHaveBeenCalledTimes(2);
        view.unmount();
    });

    it('the same widget and value on the next dashboard keeps its host: the drag goes on there', async () => {
        vi.useFakeTimers();
        const { source, write } = fakeSource();
        const view = mount(DashboardView, {
            props: { dashboard: withFader(VOL_A) as never, source },
        });
        const track = view.find('.lc-track').element as HTMLElement;
        track.getBoundingClientRect = () =>
            ({
                height: 150,
                width: 20,
                top: 0,
                left: 0,
                bottom: 150,
                right: 20,
                x: 0,
                y: 0,
                toJSON() {},
            }) as DOMRect;
        const lc = view.find('.lc').element;

        await pointer(lc, 'pointerdown', 75);
        await pointer(lc, 'pointermove', 85);
        await view.setProps({ dashboard: { ...withFader(VOL_A), name: 'Desk 2' } as never });
        await pointer(lc, 'pointermove', 95);
        await pointer(lc, 'pointerup', 95);

        expect(write.mock.calls.map(([ops]) => ops[0])).toEqual([
            { op: 'replace', path: VOL_A, value: 90 },
            { op: 'replace', path: VOL_A, value: 80 },
        ]);
        view.unmount();
    });
});

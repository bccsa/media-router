// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import XrefLinkPicker from './XrefLinkPicker.vue';
import type { LinkCandidate } from '@/utils/crossRefTypes';

function cand(over: Partial<LinkCandidate> = {}): LinkCandidate {
    return {
        pageId: 'pg-b',
        pageName: 'Studio',
        moduleId: 'srt',
        moduleName: 'SRT out',
        portId: 'ts',
        portLabel: 'TS In',
        streamType: 'muxed/mpegts',
        ...over,
    };
}

const candidates = [
    cand(),
    cand({
        moduleId: 'rist',
        moduleName: 'RIST out',
        portId: 'in',
        portLabel: 'In',
        existingRefLabel: '#4',
    }),
    cand({ moduleId: 'srt', portId: 'ts2', portLabel: 'TS In 2' }),
    cand({
        pageId: 'pg-c',
        pageName: 'Return',
        moduleId: 'rec',
        moduleName: 'Recorder',
        portId: 'in',
        portLabel: 'Rec In',
    }),
];

let mounted: ReturnType<typeof mount> | null = null;
function mountPicker(list: LinkCandidate[] = candidates, x = 100, y = 120) {
    mounted = mount(XrefLinkPicker, { props: { x, y, candidates: list }, attachTo: document.body });
    return mounted;
}
// The list is teleported to body: a failed test must not leave it for the next.
afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
});

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const inBody = (selector: string) => [...document.body.querySelectorAll(selector)];

describe('XrefLinkPicker', () => {
    it('groups ports by page, then module, in the given order', () => {
        const w = mountPicker();
        expect(inBody('[data-test="page"]').map((e) => e.textContent?.trim())).toEqual([
            'Studio',
            'Return',
        ]);
        expect(inBody('[data-test="module"]').map((e) => e.textContent?.trim())).toEqual([
            'SRT out',
            'RIST out',
            'Recorder',
        ]);
        expect(inBody('[data-test="candidate"]').map((e) => e.textContent?.trim())).toEqual([
            'TS In',
            'TS In 2',
            'In#4',
            'Rec In',
        ]);
    });

    it('emits pick with the candidate clicked', () => {
        const w = mountPicker();
        (inBody('[data-test="candidate"]')[2] as HTMLElement).click();
        expect(w.emitted('pick')).toEqual([[candidates[1]]]);
    });

    it('filters by page, module, port or tag label, and Enter picks the first shown', async () => {
        const w = mountPicker();
        const input = document.body.querySelector('input') as HTMLInputElement;
        input.value = 'recorder';
        input.dispatchEvent(new Event('input'));
        await w.vm.$nextTick();
        expect(inBody('[data-test="candidate"]')).toHaveLength(1);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(w.emitted('pick')).toEqual([[candidates[3]]]);

        input.value = '#4';
        input.dispatchEvent(new Event('input'));
        await w.vm.$nextTick();
        expect(inBody('[data-test="existing"]').map((e) => e.textContent)).toEqual(['#4']);

        input.value = 'nothing like it';
        input.dispatchEvent(new Event('input'));
        await w.vm.$nextTick();
        expect(document.body.textContent).toContain('No matches');
    });

    it('focuses the filter', async () => {
        const w = mountPicker();
        await w.vm.$nextTick();
        expect(document.activeElement).toBe(document.body.querySelector('input'));
    });

    it('says so when nothing can be linked', () => {
        const w = mountPicker([]);
        expect(inBody('[data-test="empty"]')).toHaveLength(1);
        expect(document.body.querySelector('input')).toBeNull();
    });

    it('closes on Escape', () => {
        const w = mountPicker();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(w.emitted('close')).toHaveLength(1);
    });

    it('closes on a press outside, not inside', async () => {
        const w = mountPicker();
        await nextFrame();
        inBody('[data-test="page"]')[0].dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true }),
        );
        expect(w.emitted('close')).toBeUndefined();
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(w.emitted('close')).toHaveLength(1);
    });

    it('stays inside the viewport', async () => {
        mountPicker(candidates, 5000, 5000);
        await flushPromises();
        const el = document.body.querySelector('[role="dialog"]') as HTMLElement;
        expect(parseFloat(el.style.left)).toBeLessThanOrEqual(window.innerWidth);
        expect(parseFloat(el.style.top)).toBeLessThanOrEqual(window.innerHeight);
    });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { Position, VueFlow } from '@vue-flow/core';
import XrefNode, { XREF_DBLCLICK_MS } from './XrefNode.vue';
import { XREF_HANDLE_ID, type RefNode, type XrefNodeData } from '@/utils/crossRefTypes';
import { IDLE_EDGE_COLOR } from '@/utils/edgeStyle';
import { TAG_SIZE } from '@/utils/xrefCanvas';

function tag(over: Partial<RefNode> = {}): RefNode {
    return {
        key: 'out:enc:ts',
        kind: 'out',
        moduleId: 'enc',
        portId: 'ts',
        page: 'pg-a',
        streamType: 'audio/302m',
        color: '#06b6d4',
        readOnly: false,
        n: 3,
        label: '#3',
        hint: '→ Studio',
        capacity: -1,
        links: [],
        ...over,
    };
}

// Handle needs a Vue Flow node context; a stub keeps its props visible.
function mountTag(ref: Partial<RefNode> = {}, data: Partial<XrefNodeData> = {}) {
    return mount(XrefNode, {
        props: { id: 'xref-1', data: { ref: tag(ref), ...data } },
        global: { stubs: { Handle: true } },
    });
}

afterEach(() => vi.useRealTimers());

// test-utils' trigger cannot set `detail` (a getter), so dispatch real events.
function click(w: ReturnType<typeof mountTag>, init: MouseEventInit = {}) {
    w.element.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ...init }));
}

describe('XrefNode', () => {
    it('shows the label, the hint and ∞ for an unlimited port', () => {
        const w = mountTag();
        expect(w.get('[data-test="label"]').text()).toBe('#3');
        expect(w.get('[data-test="hint"]').text()).toBe('→ Studio');
        expect(w.find('[data-test="unlimited"]').exists()).toBe(true);
        expect(mountTag({ capacity: 1 }).find('[data-test="unlimited"]').exists()).toBe(false);
    });

    it('draws label and hint on one row, TAG_SIZE.height tall', () => {
        const face = mountTag().get('[data-test="face"]');
        expect(face.attributes('style')).toContain(`height: ${TAG_SIZE.height}px`);
        expect(face.find('[data-test="label"]').exists()).toBe(true);
        expect(face.find('[data-test="hint"]').exists()).toBe(true);
    });

    it('fills body and point with the ref colour, dark text on cyan', () => {
        const w = mountTag();
        expect(w.get('[data-test="body"]').attributes('fill')).toBe('#06b6d4');
        expect(w.get('[data-test="point"]').attributes('fill')).toBe('#06b6d4');
        expect(w.get('[data-test="face"]').attributes('style')).toContain('color: rgb(15, 17, 23)');
    });

    it('draws a read-only tag in the grey deriveRefs resolved for it, white text', () => {
        const w = mountTag({ readOnly: true, color: IDLE_EDGE_COLOR, label: 'PCM' });
        expect(w.get('[data-test="body"]').attributes('fill')).toBe(IDLE_EDGE_COLOR);
        expect(w.get('[data-test="point"]').attributes('fill')).toBe(IDLE_EDGE_COLOR);
        expect(w.get('[data-test="face"]').attributes('style')).toContain(
            'color: rgb(255, 255, 255)',
        );
    });

    it('puts an output tag handle on the left as a target, never connectable', () => {
        const h = mountTag().findComponent({ name: 'Handle' });
        expect(h.props()).toMatchObject({
            id: XREF_HANDLE_ID,
            type: 'target',
            position: Position.Left,
            connectable: false,
        });
    });

    it('puts an input tag handle on the right as a source', () => {
        const h = mountTag({ kind: 'in', key: 'in:srt:ts' }).findComponent({ name: 'Handle' });
        expect(h.props()).toMatchObject({
            type: 'source',
            position: Position.Right,
            connectable: false,
        });
    });

    it('opens the dropdown at the pointer after a single click', () => {
        vi.useFakeTimers();
        const w = mountTag();
        click(w, { clientX: 40, clientY: 60 });
        expect(w.emitted('open')).toBeUndefined();
        vi.advanceTimersByTime(XREF_DBLCLICK_MS);
        expect(w.emitted('open')).toEqual([['out:enc:ts', 40, 60]]);
    });

    it('opens only the side panel on a double-click', async () => {
        vi.useFakeTimers();
        const w = mountTag();
        click(w);
        click(w, { detail: 2 });
        await w.trigger('dblclick');
        vi.advanceTimersByTime(XREF_DBLCLICK_MS * 2);
        expect(w.emitted('settings')).toEqual([['out:enc:ts']]);
        expect(w.emitted('open')).toBeUndefined();
    });

    it('drops a pending open when unmounted', () => {
        vi.useFakeTimers();
        const w = mountTag();
        click(w);
        const emitted = w.emitted();
        w.unmount();
        vi.advanceTimersByTime(XREF_DBLCLICK_MS);
        expect(emitted.open).toBeUndefined();
    });

    it('dims and highlights', () => {
        expect(mountTag({}, { dimmed: true }).attributes('style')).toContain('opacity: 0.15');
        const lit = mountTag({}, { highlighted: true });
        expect(lit.classes()).toContain('animate-pulse');
        expect(lit.attributes('style')).toContain('drop-shadow');
        const plain = mountTag();
        expect(plain.classes()).not.toContain('animate-pulse');
        expect(plain.attributes('style')).toContain('opacity: 1');
    });
});

describe('XrefNode inside Vue Flow', () => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;

    it('renders one handle that no wire can start from or snap onto', async () => {
        const App = defineComponent({
            setup: () => () =>
                h(
                    VueFlow,
                    {
                        nodes: [
                            {
                                id: 'x',
                                type: 'xref',
                                position: { x: 0, y: 0 },
                                data: { ref: tag() },
                            },
                        ],
                        edges: [],
                    },
                    { 'node-xref': (p: { id: string; data: XrefNodeData }) => h(XrefNode, p) },
                ),
        });
        const w = mount(App, { attachTo: document.body });
        await nextTick();
        const handles = w.findAll('.vue-flow__handle');
        expect(handles).toHaveLength(1);
        expect(handles[0].attributes('data-handleid')).toBe(XREF_HANDLE_ID);
        expect(handles[0].classes()).not.toContain('connectable');
        expect(handles[0].classes()).toContain('target');
        w.unmount();
    });
});

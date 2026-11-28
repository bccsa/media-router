/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';

const flow = vi.hoisted(() => ({ fitView: vi.fn() }));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({ fitView: flow.fitView, findNode: () => undefined }),
}));

import { useGraphNodes } from './useGraphNodes';

const mod = (id: string) => ({ instanceId: id, position: { x: 0, y: 0 }, ports: [] });

function setup(withPage = true) {
    const engineRef = ref({
        engineId: 'eng-1',
        modules: { a: mod('a'), b: mod('b'), c: mod('c') },
        connections: [],
        editor: {
            pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-2': { name: 'Two', order: 1 } },
            // c has no page stored: it sits on the lowest-order page.
            modulePages: { a: 'pg-1', b: 'pg-2' },
            refs: {},
            tagged: {},
            nextRef: 1,
        },
    } as unknown as EngineState);
    const page = ref('pg-1');
    const g = useGraphNodes(
        computed(() => engineRef.value),
        withPage ? () => page.value : undefined,
    );
    return { ...g, engineRef, page };
}

const ids = (nodes: { value: Node[] }) => nodes.value.map((n) => n.id);

/** The fit runs on nextTick and again after 200 ms. */
async function settle() {
    await nextTick();
    vi.advanceTimersByTime(200);
}

describe('useGraphNodes pages', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        flow.fitView.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('shows only the current page, a module with no stored page on the first one', () => {
        const { nodes } = setup();
        expect(ids(nodes)).toEqual(['a', 'c']);
    });

    it('shows every module when no page is given', () => {
        expect(ids(setup(false).nodes)).toEqual(['a', 'b', 'c']);
    });

    it('swaps the nodes on a page switch and fits the view to the new page', async () => {
        const { nodes, page } = setup();
        await settle();
        expect(flow.fitView).toHaveBeenCalledTimes(2);

        page.value = 'pg-2';
        await nextTick();
        expect(ids(nodes)).toEqual(['b']);
        await settle();
        expect(flow.fitView).toHaveBeenCalledTimes(4);
    });

    it('keepViewOnPageChange skips the fit of the next switch only', async () => {
        const { page, keepViewOnPageChange } = setup();
        await settle();
        flow.fitView.mockReset();

        keepViewOnPageChange();
        page.value = 'pg-2';
        await settle();
        expect(flow.fitView).not.toHaveBeenCalled();

        page.value = 'pg-1';
        await settle();
        expect(flow.fitView).toHaveBeenCalled();
    });

    it('a module moved to another page leaves this one, without a fit', async () => {
        const { nodes, engineRef } = setup();
        await settle();
        flow.fitView.mockReset();

        engineRef.value.editor!.modulePages.a = 'pg-2';
        await settle();
        expect(ids(nodes)).toEqual(['c']);
        expect(flow.fitView).not.toHaveBeenCalled();
    });
});

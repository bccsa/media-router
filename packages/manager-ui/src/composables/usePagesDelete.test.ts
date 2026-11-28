/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EditorLayout } from '@media-router/shared-types';
import { useEngineStore, type EngineState } from '@/stores/engines';

// The real store and patch.editor: a write removes the page at once (optimistic),
// which is what deletePage must not read the current page after.
const m = vi.hoisted(() => ({
    route: null as unknown as { query: Record<string, unknown> },
    replace: vi.fn(),
    write: vi.fn(),
}));
vi.mock('vue-router', () => ({
    useRoute: () => m.route,
    useRouter: () => ({ replace: (...a: unknown[]) => m.replace(...a) }),
}));
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ write: (...a: unknown[]) => m.write(...a) }),
}));

import { usePages } from './usePages';

const mod = (id: string, x = 0, y = 0) => ({
    instanceId: id,
    displayName: id.toUpperCase(),
    position: { x, y },
    ports: [{ id: 'out', direction: 'output', streamType: 'audio/302m' }],
});

/** Pages A, B, C with one module each; c's tag has been dragged to (300, 40). */
const layout = (): EditorLayout => ({
    pages: {
        'pg-a': { name: 'A', order: 0 },
        'pg-b': { name: 'B', order: 1 },
        'pg-c': { name: 'C', order: 2 },
    },
    modulePages: { a: 'pg-a', b: 'pg-b', c: 'pg-c' },
    refs: { 'out:c:out': { n: 1, pos: { x: 300, y: 40 } } },
    tagged: {},
    nextRef: 2,
});

const KEY = 'mr.routing.page.eng-1';
const engine = () => useEngineStore().getEngine('eng-1')!;

beforeEach(() => {
    setActivePinia(createPinia());
    useEngineStore().engines.set('eng-1', {
        engineId: 'eng-1',
        modules: { a: mod('a'), b: mod('b'), c: mod('c') },
        connections: [],
        interlocks: [],
        editor: layout(),
    } as unknown as EngineState);
    m.route = reactive({ query: {} });
    m.replace.mockReset();
    m.write.mockReset();
    m.write.mockResolvedValue({ rejected: [] });
    localStorage.clear();
});

describe('usePages: deleting a page', () => {
    it('the viewer on the deleted page follows its modules to the target, not the first page', () => {
        m.route.query.page = 'pg-c';
        const p = usePages(() => 'eng-1');
        p.deletePage('pg-c', 'pg-b');

        expect(p.currentPage.value).toBe('pg-b');
        expect(m.replace).toHaveBeenCalledWith({ query: { page: 'pg-b' } });
        expect(localStorage.getItem(KEY)).toBe('pg-b');
        expect(engine().editor?.pages).not.toHaveProperty('pg-c');
    });

    it("moves the modules right of the target's content and their dragged tags with them", () => {
        usePages(() => 'eng-1').deletePage('pg-c', 'pg-b');
        // b spans x 0–200: + 288 gap = 488, snapped to 16 → x 496; c's tag moves as far.
        expect(m.write.mock.calls[0][0]).toEqual([
            { op: 'add', path: '/engines/eng-1/editor/modulePages/c', value: 'pg-b' },
            { op: 'remove', path: '/engines/eng-1/editor/pages/pg-c' },
            { op: 'replace', path: '/engines/eng-1/modules/c/position', value: { x: 496, y: 0 } },
            {
                op: 'replace',
                path: '/engines/eng-1/editor/refs/out:c:out/pos',
                value: { x: 796, y: 40 },
            },
        ]);
        expect(engine().modules.c.position).toEqual({ x: 496, y: 0 });
        expect(engine().editor?.refs['out:c:out']).toEqual({ n: 1, pos: { x: 796, y: 40 } });
    });

    it('a viewer on another page stays there', () => {
        m.route.query.page = 'pg-a';
        const p = usePages(() => 'eng-1');
        p.deletePage('pg-c', 'pg-b');
        expect(p.currentPage.value).toBe('pg-a');
        expect(m.replace).not.toHaveBeenCalled();
    });

    it('writes nothing and keeps the view for the last page, itself or an unknown target', () => {
        m.route.query.page = 'pg-c';
        const p = usePages(() => 'eng-1');
        p.deletePage('pg-c', 'pg-c');
        p.deletePage('pg-c', 'pg-gone');

        const single = engine().editor!;
        single.pages = { 'pg-c': { name: 'C', order: 0 } };
        single.modulePages = { a: 'pg-c', b: 'pg-c', c: 'pg-c' };
        p.deletePage('pg-c', 'pg-a');

        expect(m.write).not.toHaveBeenCalled();
        expect(m.replace).not.toHaveBeenCalled();
        expect(p.currentPage.value).toBe('pg-c');
    });
});

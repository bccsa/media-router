/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick, reactive, ref, type Ref } from 'vue';
import { emptyEditorLayout } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';

const m = vi.hoisted(() => ({
    engine: null as unknown as Ref<EngineState | undefined>,
    route: null as unknown as { query: Record<string, unknown> },
    replace: vi.fn(),
    editor: vi.fn(),
    toast: vi.fn(),
}));
vi.mock('vue-router', () => ({
    useRoute: () => m.route,
    useRouter: () => ({ replace: (...a: unknown[]) => m.replace(...a) }),
}));
vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ getEngine: () => m.engine.value }),
}));
vi.mock('@/composables/usePatch', () => ({
    patch: { editor: (...a: unknown[]) => m.editor(...a) },
}));
vi.mock('@/composables/useToast', () => ({
    useToast: () => ({ show: (...a: unknown[]) => m.toast(...a) }),
}));

import { usePages } from './usePages';
import { NEW_PAGE } from '@/utils/pageMenuItems';
import { engineWith, PAGE_KEY as KEY, twoPages } from '@/testing/pagesFixture';

const opsOf = (call = 0) => m.editor.mock.calls[call][1] as Array<Record<string, unknown>>;

beforeEach(() => {
    m.engine = ref(engineWith(twoPages()));
    m.route = reactive({ query: {} });
    for (const f of [m.replace, m.editor, m.toast]) f.mockReset();
    localStorage.clear();
});

describe('usePages: the current page', () => {
    it('comes from ?page=, else the page last picked here, else the first page', () => {
        localStorage.setItem(KEY, 'pg-1');
        m.route.query.page = 'pg-src';
        expect(usePages(() => 'eng-1').currentPage.value).toBe('pg-src');

        m.route.query = {};
        localStorage.setItem(KEY, 'pg-src');
        expect(usePages(() => 'eng-1').currentPage.value).toBe('pg-src');

        localStorage.clear();
        expect(usePages(() => 'eng-1').currentPage.value).toBe('pg-1');
    });

    it('works when storage throws', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const p = usePages(() => 'eng-1');
        expect(p.currentPage.value).toBe('pg-1');
        p.selectPage('pg-src');
        expect(p.currentPage.value).toBe('pg-src');
        get.mockRestore();
        set.mockRestore();
    });

    it('keeps a requested page that is not there yet, showing the first page meanwhile', async () => {
        m.engine.value = engineWith(undefined);
        m.route.query.page = 'pg-src';
        const p = usePages(() => 'eng-1');
        expect(p.currentPage.value).toBe('pg-1');
        expect(p.tabs.value).toEqual([{ id: 'pg-1', name: 'Page 1', moduleCount: 5 }]);

        m.engine.value = engineWith(twoPages());
        expect(p.currentPage.value).toBe('pg-src');

        m.route.query = { page: 'pg-1' };
        await nextTick();
        expect(p.currentPage.value).toBe('pg-1');
    });

    it('stays on the page shown when the pages are reordered, with none picked here', async () => {
        const p = usePages(() => 'eng-1');
        expect(p.currentPage.value).toBe('pg-1');
        // Another browser moves "Sources" in front.
        const reordered = twoPages();
        reordered.pages['pg-src'].order = -1;
        m.engine.value = engineWith(reordered);
        await nextTick();
        expect(p.tabs.value[0].id).toBe('pg-src');
        expect(p.currentPage.value).toBe('pg-1');
    });

    it('a pick goes to the link (replace, query kept) and to storage', () => {
        m.route.query = { other: 'x' };
        const p = usePages(() => 'eng-1');
        p.selectPage('pg-src');
        expect(p.currentPage.value).toBe('pg-src');
        expect(m.replace).toHaveBeenCalledWith({ query: { other: 'x', page: 'pg-src' } });
        expect(localStorage.getItem(KEY)).toBe('pg-src');
    });

    it('lists tabs in order with their module counts', () => {
        expect(usePages(() => 'eng-1').tabs.value).toEqual([
            { id: 'pg-1', name: 'Page 1', moduleCount: 4 },
            { id: 'pg-src', name: 'Sources', moduleCount: 1 },
        ]);
    });
});

describe('usePages: page actions', () => {
    it('writes and selects nothing before the layout has loaded (engine from the sidebar info only)', () => {
        m.engine.value = { ...engineWith(undefined), modules: {} };
        const p = usePages(() => 'eng-1');
        p.addPage();
        p.renamePage('pg-1', 'Studio');
        p.movePage('pg-1', 1);
        p.moveModules(['enc'], NEW_PAGE);
        p.adoptModule('enc');
        expect(m.editor).not.toHaveBeenCalled();
        expect(m.replace).not.toHaveBeenCalled();
        expect(localStorage.getItem(KEY)).toBeNull();
        expect(p.currentPage.value).toBe('pg-1');
    });

    it('the first add materialises Page 1 and pins every module, then shows the new page', () => {
        m.engine.value = engineWith(emptyEditorLayout());
        const p = usePages(() => 'eng-1');
        p.addPage();

        const ops = opsOf();
        expect(m.editor.mock.calls[0][0]).toBe('eng-1');
        expect(ops[0]).toEqual({
            op: 'add',
            path: '/editor/pages/pg-1',
            value: { name: 'Page 1', order: 0 },
        });
        const pinned = ops.filter((o) => String(o.path).startsWith('/editor/modulePages/'));
        expect(pinned.map((o) => o.value)).toEqual(['pg-1', 'pg-1', 'pg-1', 'pg-1', 'pg-1']);
        const added = ops.at(-1)!;
        expect(added).toMatchObject({ op: 'add', value: { name: 'Page 2', order: 1 } });
        const newId = String(added.path).split('/').pop();
        expect(m.replace).toHaveBeenCalledWith({ query: { page: newId } });
    });

    it('renaming the implicit Page 1 materialises it first', () => {
        m.engine.value = engineWith(emptyEditorLayout());
        usePages(() => 'eng-1').renamePage('pg-1', '  Studio ');
        const ops = opsOf();
        expect(ops[0].path).toBe('/editor/pages/pg-1');
        expect(ops.at(-1)).toEqual({
            op: 'replace',
            path: '/editor/pages/pg-1/name',
            value: 'Studio',
        });
    });

    it('moves a tab by swapping orders, and writes nothing at either end', () => {
        const p = usePages(() => 'eng-1');
        p.movePage('pg-1', -1);
        expect(m.editor).not.toHaveBeenCalled();
        p.movePage('pg-1', 1);
        expect(opsOf()).toEqual([
            { op: 'replace', path: '/editor/pages/pg-1/order', value: 1 },
            { op: 'replace', path: '/editor/pages/pg-src/order', value: 0 },
        ]);
    });
});

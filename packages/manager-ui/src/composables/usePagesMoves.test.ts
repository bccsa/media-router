/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive, ref, type Ref } from 'vue';
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
import { engineWith, twoPages } from '@/testing/pagesFixture';

const opsOf = (call = 0) => m.editor.mock.calls[call][1] as Array<Record<string, unknown>>;

beforeEach(() => {
    m.engine = ref(engineWith(twoPages()));
    m.route = reactive({ query: {} });
    for (const f of [m.replace, m.editor, m.toast]) f.mockReset();
    localStorage.clear();
});

describe('usePages: moving modules', () => {
    it('refuses a move that splits a PipeWire wire, with a toast and no write', () => {
        const p = usePages(() => 'eng-1');
        const reason = 'Would split the PipeWire wire MIC → SPK across pages';
        expect(p.moveRefusal(['mic'], 'pg-src')).toBe(reason);
        expect(p.moveRefusal(['mic', 'spk'], 'pg-src')).toBeNull();
        expect(p.moveRefusal(['spk'], NEW_PAGE)).toBe(reason);

        p.moveModules(['mic'], 'pg-src');
        p.moveModules(['spk'], NEW_PAGE);
        expect(m.toast.mock.calls).toEqual([[reason], [reason]]);
        expect(m.editor).not.toHaveBeenCalled();
    });

    it('places moved modules right of the target page content, dragged tags along, in one write', () => {
        const refs = { 'out:enc:out': { n: 1, pos: { x: 720, y: 310 } } };
        m.engine.value = engineWith({ ...twoPages(), refs, nextRef: 2 });
        usePages(() => 'eng-1').moveModules(['enc'], 'pg-src');
        // src2 spans x 0–200 at y 32: + 288 gap = 488, snapped to 16 → x 496, top-aligned.
        expect(opsOf()).toEqual([
            { op: 'add', path: '/editor/modulePages/enc', value: 'pg-src' },
            { op: 'replace', path: '/modules/enc/position', value: { x: 496, y: 32 } },
            { op: 'replace', path: '/editor/refs/out:enc:out/pos', value: { x: 716, y: 42 } },
        ]);
    });

    it('"Move to new page" adds the page and moves there, positions kept', () => {
        usePages(() => 'eng-1').moveModules(['mic', 'spk'], NEW_PAGE);
        const ops = opsOf();
        expect(ops[0]).toMatchObject({ op: 'add', value: { name: 'Page 3', order: 2 } });
        const id = String(ops[0].path).split('/').pop();
        expect(ops.slice(1)).toEqual([
            { op: 'add', path: '/editor/modulePages/mic', value: id },
            { op: 'add', path: '/editor/modulePages/spk', value: id },
        ]);
    });

    it('new modules go to the current page once real pages exist', () => {
        m.route.query.page = 'pg-src';
        expect(usePages(() => 'eng-1').newModuleOps(['new1'])).toEqual([
            { op: 'add', path: '/editor/modulePages/new1', value: 'pg-src' },
        ]);
        m.engine.value = engineWith(undefined);
        expect(usePages(() => 'eng-1').newModuleOps(['new1'])).toEqual([]);
    });

    it('adopts a module made elsewhere only when it has no page yet', () => {
        m.route.query.page = 'pg-src';
        const p = usePages(() => 'eng-1');
        p.adoptModule('enc');
        expect(m.editor).not.toHaveBeenCalled();
        p.adoptModule('enc-copy');
        expect(opsOf()).toEqual([
            { op: 'add', path: '/editor/modulePages/enc-copy', value: 'pg-src' },
        ]);
    });
});

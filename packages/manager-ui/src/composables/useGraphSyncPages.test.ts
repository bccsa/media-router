/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import type { GraphPages } from './useGraphSync';

const m = vi.hoisted(() => ({
    fitView: vi.fn(),
    setCenter: vi.fn(),
    editor: vi.fn(),
    positions: vi.fn(),
}));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        fitView: m.fitView,
        setCenter: m.setCenter,
        screenToFlowCoordinate: () => ({ x: 0, y: 0 }),
        onNodesInitialized: () => {},
        onNodesChange: () => {},
        findNode: () => undefined,
    }),
}));
vi.mock('@/stores/engines', () => ({ useEngineStore: () => ({ removeConnection: vi.fn() }) }));
vi.mock('@/composables/usePatch', () => ({
    patch: {
        editor: (...a: unknown[]) => m.editor(...a),
        modulePositions: (...a: unknown[]) => m.positions(...a),
    },
}));
vi.mock('@/utils/ids', () => ({ newModuleInstanceId: () => 'gain-new' }));

import { useGraphSync } from './useGraphSync';

const mod = (id: string, position?: { x: number; y: number }) => ({
    instanceId: id,
    position,
    ports: [],
});

function setup() {
    const engine = ref({
        engineId: 'eng-1',
        modules: { a: mod('a', { x: 10, y: 20 }), b: mod('b', { x: 400, y: 500 }), c: mod('c') },
        connections: [],
        editor: {
            pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-2': { name: 'Two', order: 1 } },
            modulePages: { a: 'pg-1', b: 'pg-2', c: 'pg-2' },
            refs: {},
            tagged: {},
            nextRef: 1,
        },
    } as unknown as EngineState);
    const current = ref('pg-1');
    const pages: GraphPages = {
        currentPage: computed(() => current.value),
        pageOf: (id) => engine.value.editor!.modulePages[id],
        selectPage: vi.fn((id: string) => (current.value = id)),
        newModuleOps: vi.fn((ids: readonly string[]) =>
            ids.map((id) => ({
                op: 'add' as const,
                path: `/editor/modulePages/${id}`,
                value: current.value,
            })),
        ),
    };
    const g = useGraphSync(
        () => 'eng-1',
        computed(() => engine.value),
        ref(false),
        computed(() => new Set<string>()),
        () => false,
        pages,
    );
    return { ...g, pages, current };
}

const settle = async () => {
    await nextTick();
    vi.advanceTimersByTime(200);
};

beforeEach(() => {
    vi.useFakeTimers();
    for (const f of Object.values(m)) f.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useGraphSync with pages', () => {
    it('adds a module and puts it on the current page in one write', () => {
        const g = setup();
        g.current.value = 'pg-2';
        g.onAddModule({ pluginId: 'gain' }, 'Gain');

        expect(m.editor).toHaveBeenCalledTimes(1);
        const [engineId, ops] = m.editor.mock.calls[0];
        expect(engineId).toBe('eng-1');
        expect(ops.map((o: { path: string }) => o.path)).toEqual([
            '/modules/gain-new',
            '/editor/modulePages/gain-new',
        ]);
        expect(ops[1].value).toBe('pg-2');
        expect(ops[0].value).toMatchObject({ instanceId: 'gain-new', displayName: 'Gain' });
    });

    it('focusModule switches to the module page and centres on it, with no page fit', async () => {
        const g = setup();
        await settle();
        m.fitView.mockReset();

        g.focusModule('b');
        expect(g.pages.selectPage).toHaveBeenCalledWith('pg-2');
        expect(m.setCenter).toHaveBeenCalledWith(500, 540, { zoom: 1, duration: 300 });
        await settle();
        expect((g.nodes.value as Node[]).map((n) => n.id)).toEqual(['b', 'c']);
        expect(m.fitView).not.toHaveBeenCalled();
    });

    it('focusModule on a module without a position shows its page fitted', async () => {
        const g = setup();
        await settle();
        m.fitView.mockReset();

        g.focusModule('c');
        expect(g.pages.selectPage).toHaveBeenCalledWith('pg-2');
        expect(m.setCenter).not.toHaveBeenCalled();
        await settle();
        expect(m.fitView).toHaveBeenCalled();
    });

    it('focusModule on the current page only centres', () => {
        const g = setup();
        g.focusModule('a');
        expect(g.pages.selectPage).not.toHaveBeenCalled();
        expect(m.setCenter).toHaveBeenCalledWith(110, 60, { zoom: 1, duration: 300 });
    });

    it('a drag saves module positions only, never a tag', () => {
        const g = setup();
        const node = (id: string, type: string) =>
            ({ id, type, position: { x: 1, y: 2 } }) as unknown as Node;
        const moved = [node('a', 'module'), node('ref:out:a:out', 'xref')];
        g.onNodeDragStart({ nodes: moved });
        g.onNodeDragStop({ nodes: moved });
        expect(m.positions).toHaveBeenCalledWith('eng-1', [{ id: 'a', x: 1, y: 2 }]);

        g.onNodeDragStop({ node: moved[1] });
        expect(m.positions).toHaveBeenCalledTimes(1);
    });
});

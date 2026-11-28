// The routing canvas with real cross-refs for the useGraphSync tests (not shipped:
// only tests import it). Vue Flow and the writes are faked by each test file.
import { computed, ref } from 'vue';
import { vi } from 'vitest';
import type { Edge, Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { useGraphSync, type GraphPages } from '@/composables/useGraphSync';

export const mod = (id: string, x: number, y: number) => ({
    instanceId: id,
    displayName: id,
    running: true,
    position: { x, y },
    ports: [
        { id: 'out', direction: 'output', streamType: 'audio/302m' },
        { id: 'in', direction: 'input', streamType: 'audio/302m' },
    ],
});
export const conn = (src: string, sink: string) => ({
    id: `${src}:out-${sink}:in`,
    sourceModuleId: src,
    sourcePortId: 'out',
    sinkModuleId: sink,
    sinkPortId: 'in',
});

/** a's output feeds b and c on Page 1 (wires) and d on page Two (a tag): mixed wiring on one port. */
export function setupGraph() {
    const engine = ref({
        engineId: 'eng-1',
        running: true,
        modules: {
            a: mod('a', 0, 0),
            b: mod('b', 400, 0),
            c: mod('c', 400, 200),
            d: mod('d', 0, 0),
        },
        connections: [conn('a', 'b'), conn('a', 'c'), conn('a', 'd')],
        editor: {
            pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-2': { name: 'Two', order: 1 } },
            modulePages: { a: 'pg-1', b: 'pg-1', c: 'pg-1', d: 'pg-2' },
            refs: { 'out:a:out': { n: 1 } },
            tagged: {},
            nextRef: 2,
        },
    } as unknown as EngineState);
    const current = ref('pg-1');
    const pages: GraphPages = {
        currentPage: computed(() => current.value),
        pageOf: (id) => engine.value.editor!.modulePages[id],
        selectPage: vi.fn((id: string) => (current.value = id)),
        newModuleOps: () => [],
    };
    const focusMode = ref(false);
    const focused = ref(new Set<string>());
    const g = useGraphSync(
        () => 'eng-1',
        computed(() => engine.value),
        focusMode,
        computed(() => focused.value),
        (s, t) => focusMode.value && (!focused.value.has(s) || !focused.value.has(t)),
        pages,
    );
    return { ...g, engine, current, focusMode, focused };
}

export const ids = (list: { value: Array<{ id: string }> }) => list.value.map((x) => x.id).sort();
export const nodeOf = (nodes: { value: Node[] }, id: string) =>
    nodes.value.find((n) => n.id === id)!;
export const edgeOf = (edges: { value: Edge[] }, id: string) =>
    edges.value.find((e) => e.id === id)!;

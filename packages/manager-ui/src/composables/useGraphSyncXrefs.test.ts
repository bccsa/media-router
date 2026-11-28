/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { Edge, Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import type { GraphPages } from './useGraphSync';
import { TAG_SIZE } from '@/utils/xrefCanvas';

// The canvas with real cross-refs, tag nodes and edges; Vue Flow and the writes are faked.
const m = vi.hoisted(() => ({
    initialized: [] as Array<() => void>,
    nodesChange: [] as Array<(changes: Array<{ id: string; type: string }>) => void>,
    boxes: {} as Record<string, unknown>,
    updateNode: vi.fn(),
    editor: vi.fn(),
    raw: vi.fn(),
    positions: vi.fn(),
}));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        fitView: vi.fn(),
        setCenter: vi.fn(),
        screenToFlowCoordinate: (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 }),
        onNodesInitialized: (cb: () => void) => m.initialized.push(cb),
        onNodesChange: (cb: (typeof m.nodesChange)[number]) => m.nodesChange.push(cb),
        findNode: (id: string) => m.boxes[id],
        updateNode: (...a: unknown[]) => m.updateNode(...a),
    }),
}));
vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ removeConnection: vi.fn(), getEngine: vi.fn() }),
}));
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ write: vi.fn(async () => ({ rejected: [] })) }),
}));
vi.mock('@/composables/usePatch', () => ({
    patch: {
        editor: (...a: unknown[]) => m.editor(...a),
        raw: (...a: unknown[]) => m.raw(...a),
        modulePositions: (...a: unknown[]) => m.positions(...a),
    },
}));

import { useGraphSync } from './useGraphSync';

const mod = (id: string, x: number, y: number) => ({
    instanceId: id,
    displayName: id,
    running: true,
    position: { x, y },
    ports: [
        { id: 'out', direction: 'output', streamType: 'audio/302m' },
        { id: 'in', direction: 'input', streamType: 'audio/302m' },
    ],
});
const conn = (src: string, sink: string) => ({
    id: `${src}:out-${sink}:in`,
    sourceModuleId: src,
    sourcePortId: 'out',
    sinkModuleId: sink,
    sinkPortId: 'in',
});

/** a's output feeds b and c on Page 1 (wires) and d on page Two (a tag): mixed wiring on one port. */
function setup() {
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

const handlesMounted = () => m.initialized.forEach((cb) => cb());
const nodesChanged = (changes: Array<{ id: string; type: string }>) =>
    m.nodesChange.forEach((cb) => cb(changes));
const ids = (list: { value: Array<{ id: string }> }) => list.value.map((x) => x.id).sort();
const nodeOf = (nodes: { value: Node[] }, id: string) => nodes.value.find((n) => n.id === id)!;
const edgeOf = (edges: { value: Edge[] }, id: string) => edges.value.find((e) => e.id === id)!;

describe('useGraphSync cross-reference tags', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        m.initialized.length = 0;
        m.nodesChange.length = 0;
        m.boxes = {};
        for (const f of [m.updateNode, m.editor, m.raw, m.positions]) f.mockReset();
    });
    afterEach(() => vi.useRealTimers());

    it('draws 2 direct wires and 1 tag on one port, the stub from the port to the tag handle', () => {
        const { nodes, edges } = setup();
        expect(ids(nodes)).toEqual(['a', 'b', 'c', 'out:a:out']);
        const tag = nodeOf(nodes, 'out:a:out');
        expect(tag.type).toBe('xref');
        // Beside a's right edge until measured: 200 wide, 48 gap, centred on mid-height.
        expect(tag.position).toEqual({ x: 248, y: 40 - TAG_SIZE.height / 2 });
        expect(tag.data.ref.label).toBe('#1');

        handlesMounted();
        expect(ids(edges)).toEqual(['a:out-b:in', 'a:out-c:in', 'ref:out:a:out']);
        expect(edgeOf(edges, 'ref:out:a:out')).toMatchObject({
            source: 'a',
            sourceHandle: 'out',
            target: 'out:a:out',
            targetHandle: 'tag',
            animated: true,
            style: { stroke: '#06b6d4' },
        });
    });

    it('holds the edges when a new tag appears, then draws it with the wire it replaced gone', async () => {
        const { edges, engine, nodes } = setup();
        handlesMounted();
        engine.value.editor!.tagged = { 'a:out-b:in': true };
        await nextTick();
        expect(ids(nodes)).toContain('in:b:in');
        // Still the old edges: the new tag's handle is not mounted yet.
        expect(ids(edges)).toEqual(['a:out-b:in', 'a:out-c:in', 'ref:out:a:out']);
        handlesMounted();
        expect(ids(edges)).toEqual(['a:out-c:in', 'ref:in:b:in', 'ref:out:a:out']);
        expect(edgeOf(edges, 'ref:in:b:in')).toMatchObject({
            source: 'in:b:in',
            sourceHandle: 'tag',
            target: 'b',
            targetHandle: 'in',
        });
    });

    it('places undragged tags beside the measured handle once the nodes are initialized', () => {
        const { nodes } = setup();
        m.boxes.a = {
            position: { x: 0, y: 0 },
            dimensions: { width: 240, height: 100 },
            handleBounds: { source: [{ id: 'out', x: 234, y: 44, width: 12, height: 12 }] },
        };
        handlesMounted();
        expect(nodeOf(nodes, 'out:a:out').position).toEqual({
            x: 240 + 48,
            y: 50 - TAG_SIZE.height / 2,
        });
    });

    it('places an input tag again when it is measured anew (a longer name), not on other changes', () => {
        const { nodes, engine } = setup();
        engine.value.editor!.tagged = { 'a:out-b:in': true };
        m.boxes['in:b:in'] = { dimensions: { width: 80, height: 32 } };
        handlesMounted();
        // Left of b's left edge (x 400) by the gap and its width, centred on mid-height.
        expect(nodeOf(nodes, 'in:b:in').position).toEqual({ x: 400 - 48 - 80, y: 24 });

        m.boxes['in:b:in'] = { dimensions: { width: 150, height: 32 } };
        nodesChanged([
            { id: 'in:b:in', type: 'position' },
            { id: 'zz', type: 'dimensions' },
        ]);
        expect(nodeOf(nodes, 'in:b:in').position.x).toBe(400 - 48 - 80);
        nodesChanged([{ id: 'in:b:in', type: 'dimensions' }]);
        expect(nodeOf(nodes, 'in:b:in').position).toEqual({ x: 400 - 48 - 150, y: 24 });
    });

    it("places a module's tags again when the module is measured anew", () => {
        const { nodes } = setup();
        handlesMounted();
        m.boxes.a = { position: { x: 0, y: 0 }, dimensions: { width: 320, height: 80 } };
        nodesChanged([{ id: 'a', type: 'dimensions' }]);
        expect(nodeOf(nodes, 'out:a:out').position).toEqual({
            x: 320 + 48,
            y: 40 - TAG_SIZE.height / 2,
        });
    });

    it('moves undragged tags with a dragged module inside Vue Flow, and saves dragged tags', async () => {
        const { nodes, onNodeDragStart, onNodeDrag, onNodeDragStop, engine } = setup();
        const tagBefore = nodeOf(nodes, 'out:a:out');
        const a = { id: 'a', type: 'module', position: { x: 100, y: 50 } } as Node;
        m.boxes.a = a;
        onNodeDragStart({ node: a });
        onNodeDrag({ node: a });
        const followed = { x: 348, y: 50 + 40 - TAG_SIZE.height / 2 };
        expect(m.updateNode).toHaveBeenCalledWith('out:a:out', { position: followed });
        expect(nodeOf(nodes, 'out:a:out').position).toEqual(followed);
        // No tag re-sent mid-drag, even when the layout changes meanwhile.
        engine.value.editor!.refs['out:a:out'] = { n: 1, name: 'Main' };
        engine.value.editor = { ...engine.value.editor! };
        await nextTick();
        expect(nodeOf(nodes, 'out:a:out')).toBe(tagBefore);
        onNodeDragStop({ node: a });
        expect(m.positions).toHaveBeenCalledWith('eng-1', [{ id: 'a', x: 100, y: 50 }]);
        expect(nodeOf(nodes, 'out:a:out').data.ref.label).toBe('Main');

        const tag = { id: 'out:a:out', type: 'xref', position: { x: 600.4, y: 80 } } as Node;
        onNodeDragStart({ node: tag });
        onNodeDragStop({ node: tag });
        expect(m.editor).toHaveBeenCalledWith('eng-1', [
            { op: 'add', path: '/editor/refs/out:a:out/pos', value: { x: 600, y: 80 } },
        ]);
        expect(m.positions).toHaveBeenCalledTimes(1);
    });

    it("Format lays out the page's modules and puts its dragged tags back beside their ports", () => {
        const { formatPage, engine } = setup();
        engine.value.editor!.refs['out:a:out'] = { n: 1, pos: { x: 9, y: 9 } };
        formatPage();
        const ops = m.raw.mock.calls[0][1] as Array<{ op: string; path: string }>;
        expect(
            ops
                .filter((o) => o.op === 'replace')
                .map((o) => o.path)
                .sort(),
        ).toEqual(['/modules/a/position', '/modules/b/position', '/modules/c/position']);
        expect(ops.filter((o) => o.op === 'remove')).toEqual([
            { op: 'remove', path: '/editor/refs/out:a:out/pos' },
        ]);
    });

    it('a wire dropped on empty canvas opens the link picker at the pointer', () => {
        const { onConnectStart, onConnectEnd, crossRefs } = setup();
        document.body.innerHTML = '<div class="vue-flow__pane"></div>';
        document.elementFromPoint = () => document.querySelector('.vue-flow__pane');
        onConnectStart({ nodeId: 'a', handleId: 'out' });
        onConnectEnd(new MouseEvent('mouseup', { clientX: 30, clientY: 40 }));
        expect(crossRefs!.linkPicker.value).toMatchObject({
            x: 30,
            y: 40,
            origin: { moduleId: 'a', portId: 'out', direction: 'output' },
            dropAt: { x: 60, y: 80 },
        });
    });

    it('dims a tag and its stub with its module in focus mode', async () => {
        const { nodes, edges, focusMode, focused } = setup();
        handlesMounted();
        focused.value = new Set(['b']);
        focusMode.value = true;
        await nextTick();
        expect(nodeOf(nodes, 'out:a:out').data.dimmed).toBe(true);
        expect(edgeOf(edges, 'ref:out:a:out').style).toMatchObject({ opacity: 0.1 });
        focused.value = new Set(['a']);
        await nextTick();
        expect(nodeOf(nodes, 'out:a:out').data.dimmed).toBe(false);
    });
});

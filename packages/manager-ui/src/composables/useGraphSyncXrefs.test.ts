/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import type { Node } from '@vue-flow/core';
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

import { edgeOf, ids, nodeOf, setupGraph as setup } from '@/testing/graphSyncFixture';

const handlesMounted = () => m.initialized.forEach((cb) => cb());
const nodesChanged = (changes: Array<{ id: string; type: string }>) =>
    m.nodesChange.forEach((cb) => cb(changes));

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
});

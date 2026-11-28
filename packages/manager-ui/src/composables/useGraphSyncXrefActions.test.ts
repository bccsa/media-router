/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';

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

import { edgeOf, nodeOf, setupGraph as setup } from '@/testing/graphSyncFixture';
import { TAG_GAP, TAG_SIZE } from '@/utils/xrefCanvas';

const handlesMounted = () => m.initialized.forEach((cb) => cb());
/** Module positions in a Format write. */
const placed = (call: number) =>
    Object.fromEntries(
        (m.raw.mock.calls[call][1] as Array<{ path: string; value: { x: number } }>)
            .filter((o) => o.path.startsWith('/modules/'))
            .map((o) => [o.path.split('/')[2], o.value]),
    );

describe('useGraphSync cross-reference tags: Format, linking, focus', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        m.initialized.length = 0;
        m.nodesChange.length = 0;
        m.boxes = {};
        for (const f of [m.updateNode, m.editor, m.raw, m.positions]) f.mockReset();
    });
    afterEach(() => vi.useRealTimers());

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

    it('Format leaves room between columns for a tag on each side, as wide as the widest tag', () => {
        const { formatPage, engine } = setup();
        handlesMounted(); // the wires are drawn: a → b, a → c
        m.boxes['out:a:out'] = { dimensions: { width: 120, height: TAG_SIZE.height } };
        formatPage();
        const tagged = placed(0);
        // a (200 wide) → b: a's output tag and an input tag of b, each 48 + 120, fit between.
        expect(tagged.b.x - (tagged.a.x + 200)).toBeGreaterThanOrEqual(2 * (TAG_GAP + 120));

        // No tag on the page: the compact columns.
        engine.value.connections = engine.value.connections.filter((c) => c.sinkModuleId !== 'd');
        formatPage();
        const plain = placed(1);
        expect(plain.b.x - (plain.a.x + 200)).toBeLessThan(2 * TAG_GAP);
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

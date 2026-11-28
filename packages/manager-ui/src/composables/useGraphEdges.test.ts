/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { Edge } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';

// Capture onNodesInitialized so a test can say when the handles have mounted.
const flow = vi.hoisted(() => ({ nodesInitialized: [] as Array<() => void> }));
vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        onNodesInitialized: (cb: () => void) => flow.nodesInitialized.push(cb),
    }),
}));

import { deriveRefs, directOnPage, stubsOnPage } from '@/utils/crossRefs';
import { useGraphEdges } from './useGraphEdges';

const mod = (id: string) => ({
    instanceId: id,
    running: false,
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

function setup() {
    const engineRef = ref({
        engineId: 'eng-1',
        running: false,
        modules: { a: mod('a'), b: mod('b'), c: mod('c') },
        connections: [conn('a', 'b')],
    } as unknown as EngineState);
    const engine = computed(() => engineRef.value);
    const g = useGraphEdges(
        engine,
        ref(false),
        computed(() => new Set<string>()),
        () => false,
    );
    return { ...g, engineRef };
}

const handlesMounted = () => flow.nodesInitialized.forEach((cb) => cb());
const ids = (edges: { value: Edge[] }) => edges.value.map((e) => e.id);
/** The wires only, without the tag stubs (`ref:<key>`). */
const wires = (edges: { value: Edge[] }) => ids(edges).filter((id) => !id.startsWith('ref:'));

describe('useGraphEdges pending-edges latch', () => {
    beforeEach(() => {
        flow.nodesInitialized.length = 0;
    });

    it('holds the edges until the handles mount, then publishes them', () => {
        const { edges } = setup();
        expect(edges.value).toEqual([]);

        handlesMounted();
        expect(ids(edges)).toEqual(['a:out-b:in']);
    });

    it('publishes later changes at once once the handles are mounted', async () => {
        const { edges, engineRef } = setup();
        handlesMounted();

        engineRef.value.connections.push(conn('a', 'c'));
        await nextTick();
        expect(ids(edges)).toEqual(['a:out-b:in', 'a:out-c:in']);
    });
});

describe('useGraphEdges pages', () => {
    beforeEach(() => {
        flow.nodesInitialized.length = 0;
    });

    /** a, b on pg-1 and c on pg-2; a → b, a → c (cross-page), b → d (tagged on pg-1); e alone on pg-3. */
    function setupPaged() {
        const engineRef = ref({
            engineId: 'eng-1',
            running: false,
            modules: { a: mod('a'), b: mod('b'), c: mod('c'), d: mod('d'), e: mod('e') },
            connections: [conn('a', 'b'), conn('a', 'c'), conn('b', 'd')],
            editor: {
                pages: {
                    'pg-1': { name: 'Page 1', order: 0 },
                    'pg-2': { name: 'Two', order: 1 },
                    'pg-3': { name: 'Three', order: 2 },
                },
                modulePages: { a: 'pg-1', b: 'pg-1', c: 'pg-2', d: 'pg-1', e: 'pg-3' },
                refs: {},
                tagged: { 'b:out-d:in': true },
                nextRef: 1,
            },
        } as unknown as EngineState);
        const page = ref('pg-1');
        // What useCrossRefs hands the canvas: the page's direct wires and tag stubs.
        const derived = () => {
            const { modules, connections, editor } = engineRef.value;
            return deriveRefs(modules, connections, editor, {});
        };
        const g = useGraphEdges(
            computed(() => engineRef.value),
            ref(false),
            computed(() => new Set<string>()),
            () => false,
            () => page.value,
            {
                direct: () => {
                    const { connections, editor } = engineRef.value;
                    return directOnPage(derived(), connections, editor, page.value);
                },
                stubs: () => stubsOnPage(derived(), page.value),
            },
        );
        handlesMounted();
        return { ...g, engineRef, page };
    }

    it("draws the page's direct wires and its tag stubs: no cross-page or tagged wire", () => {
        expect(ids(setupPaged().edges)).toEqual([
            'a:out-b:in',
            'ref:out:a:out',
            'ref:out:b:out',
            'ref:in:d:in',
        ]);
    });

    it('holds the edges when a new tag appears until its node has mounted', async () => {
        const { edges, engineRef } = setupPaged();
        engineRef.value.editor!.tagged['a:out-b:in'] = true;
        await nextTick();
        // Still the old edges: the new tag's handle is not mounted yet.
        expect(ids(edges)).toContain('a:out-b:in');
        expect(ids(edges)).not.toContain('ref:in:b:in');

        handlesMounted();
        expect(ids(edges)).not.toContain('a:out-b:in');
        expect(ids(edges)).toContain('ref:in:b:in');
    });

    it('holds a new page until its handles mount, then shows its wires', async () => {
        const { edges, page, engineRef } = setupPaged();
        engineRef.value.editor!.modulePages.b = 'pg-2';
        page.value = 'pg-2';
        await nextTick();
        expect(wires(edges)).toEqual(['a:out-b:in']);

        handlesMounted();
        expect(wires(edges)).toEqual([]);
        engineRef.value.connections.push(conn('c', 'b'));
        await nextTick();
        expect(wires(edges)).toEqual(['c:out-b:in']);
    });

    it('an empty page clears the wires at once', async () => {
        const { edges, page, engineRef } = setupPaged();
        engineRef.value.editor!.modulePages.e = 'pg-1';
        page.value = 'pg-3';
        await nextTick();
        expect(edges.value).toEqual([]);
    });

    it('a module moving away takes its wires at once; one moving in waits for its handles', async () => {
        const { edges, engineRef } = setupPaged();
        engineRef.value.editor!.modulePages.b = 'pg-2';
        await nextTick();
        expect(wires(edges)).toEqual([]);

        engineRef.value.editor!.modulePages.c = 'pg-1';
        await nextTick();
        expect(wires(edges)).toEqual([]);
        handlesMounted();
        expect(wires(edges)).toEqual(['a:out-c:in']);
    });

    it('untagging a wire draws it again', async () => {
        const { edges, engineRef } = setupPaged();
        delete engineRef.value.editor!.tagged['b:out-d:in'];
        await nextTick();
        expect(wires(edges)).toEqual(['a:out-b:in', 'b:out-d:in']);
    });
});

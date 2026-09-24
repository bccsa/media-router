/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { Edge } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';

// Vue Flow needs a mounted <VueFlow> to provide its store — stub the pieces
// `useGraphSync` calls, and capture the `onNodesInitialized` callback so the
// test can flush the deferred (pending) edges the same way the real graph does.
const flow = vi.hoisted(() => ({
    nodesInitialized: [] as Array<() => void>,
    raw: (() => {}) as (...args: unknown[]) => void,
}));

vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        fitView: vi.fn(),
        setCenter: vi.fn(),
        screenToFlowCoordinate: vi.fn(() => ({ x: 0, y: 0 })),
        onNodesInitialized: (cb: () => void) => flow.nodesInitialized.push(cb),
        findNode: vi.fn(() => undefined),
    }),
}));

vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ removeConnection: vi.fn() }),
}));

vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ emit: vi.fn() }),
}));

vi.mock('@/composables/usePatch', () => ({
    patch: {
        addConnection: vi.fn(),
        removeConnection: vi.fn(),
        addModule: vi.fn(),
        modulePositions: (...args: unknown[]) => flow.raw(...args),
    },
}));

import { useGraphSync } from './useGraphSync';

function makeModule(id: string, running: boolean) {
    return {
        instanceId: id,
        pluginId: 'test',
        displayName: id,
        running,
        enabled: true,
        health: running ? 'running' : 'stopped',
        pendingRestart: false,
        settings: {},
        ports: [
            { id: 'out', direction: 'output', streamType: 'audio/pcm' },
            { id: 'in', direction: 'input', streamType: 'audio/pcm' },
        ],
    };
}

/** Engine with `src -> sink`, both wired on the audio/pcm ports. */
function makeEngine(opts: { engineRunning: boolean; src: boolean; sink: boolean }): EngineState {
    return {
        engineId: 'eng-1',
        name: 'Test',
        online: true,
        running: opts.engineRunning,
        activeProfile: null,
        modules: {
            src: makeModule('src', opts.src),
            sink: makeModule('sink', opts.sink),
        },
        connections: [
            {
                id: 'src:out-sink:in',
                sourceModuleId: 'src',
                sourcePortId: 'out',
                sinkModuleId: 'sink',
                sinkPortId: 'in',
            },
        ],
        interlocks: [],
    } as unknown as EngineState;
}

/** Instantiate the composable and flush the pending edges (handles mounted). */
function mount(state: ReturnType<typeof makeEngine>) {
    const engineRef = ref(state);
    const engine = computed(() => engineRef.value);
    const focusMode = ref(false);
    const focusedModules = computed(() => new Set<string>());
    const { edges, onNodeDragStart, onNodeDragStop } = useGraphSync(
        () => 'eng-1',
        engine,
        focusMode,
        focusedModules,
        () => false,
    );
    for (const cb of flow.nodesInitialized) cb();
    return { edges, engineRef, onNodeDragStart, onNodeDragStop };
}

/** Stream colour for audio/pcm, and the grey an idle (non-flowing) edge wears. */
const PCM = '#3b82f6';
const IDLE = '#6b7280';

const strokeOf = (edges: { value: unknown }) =>
    ((edges.value as Edge[])[0].style as Record<string, string>).stroke;

describe('useGraphSync edge animation', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        flow.nodesInitialized.length = 0;
    });

    it('animates and colours the edge when the engine and both modules are running', () => {
        const { edges } = mount(makeEngine({ engineRunning: true, src: true, sink: true }));
        expect(edges.value).toHaveLength(1);
        expect((edges.value as Edge[])[0].animated).toBe(true);
        expect(strokeOf(edges)).toBe(PCM);
    });

    it('does not animate, and greys the stroke, when the engine is stopped', () => {
        const { edges } = mount(makeEngine({ engineRunning: false, src: true, sink: true }));
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);
    });

    it('does not animate, and greys the stroke, when the source module is stopped', () => {
        const { edges } = mount(makeEngine({ engineRunning: true, src: false, sink: true }));
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);
    });

    it('does not animate, and greys the stroke, when the sink module is stopped', () => {
        const { edges } = mount(makeEngine({ engineRunning: true, src: true, sink: false }));
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);
    });

    it('rebuilds edges when a module starts or stops', async () => {
        const { edges, engineRef } = mount(
            makeEngine({ engineRunning: true, src: false, sink: true }),
        );
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);

        engineRef.value.modules.src!.running = true;
        await nextTick();
        expect((edges.value as Edge[])[0].animated).toBe(true);
        expect(strokeOf(edges)).toBe(PCM);

        engineRef.value.modules.sink!.running = false;
        await nextTick();
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);
    });

    it('rebuilds edges when the engine starts or stops', async () => {
        const { edges, engineRef } = mount(
            makeEngine({ engineRunning: true, src: true, sink: true }),
        );
        expect((edges.value as Edge[])[0].animated).toBe(true);
        expect(strokeOf(edges)).toBe(PCM);

        engineRef.value.running = false;
        await nextTick();
        expect((edges.value as Edge[])[0].animated).toBe(false);
        expect(strokeOf(edges)).toBe(IDLE);
    });

    it('keeps dimming and interaction width independent of flow state', () => {
        const { edges } = mount(makeEngine({ engineRunning: false, src: false, sink: false }));
        const edge = (edges.value as Edge[])[0];
        expect(edge.style).toMatchObject({
            stroke: IDLE,
            opacity: 1,
            transition: 'opacity 0.2s ease, stroke 0.2s ease',
        });
        expect(edge.interactionWidth).toBe(20);
    });
});

describe('useGraphSync group drag', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        flow.nodesInitialized.length = 0;
    });

    const node = (id: string, x: number, y: number) =>
        ({ id, position: { x, y } }) as unknown as import('@vue-flow/core').Node;

    it('persists every node of a group drag in one patch', () => {
        const raw = vi.fn();
        flow.raw = raw;
        const g = mount(makeEngine({ engineRunning: false, src: false, sink: false }));
        const moved = [node('src', 16, 32), node('sink', 400, 32)];

        g.onNodeDragStart({ node: moved[0], nodes: moved });
        g.onNodeDragStop({ node: moved[0], nodes: moved });

        expect(raw).toHaveBeenCalledTimes(1);
        expect(raw).toHaveBeenCalledWith('eng-1', [
            { id: 'src', x: 16, y: 32 },
            { id: 'sink', x: 400, y: 32 },
        ]);
    });

    it('still persists a single-node drag without a nodes array', () => {
        const raw = vi.fn();
        flow.raw = raw;
        const g = mount(makeEngine({ engineRunning: false, src: false, sink: false }));

        g.onNodeDragStop({ node: node('src', 48, 64) });

        expect(raw).toHaveBeenCalledWith('eng-1', [{ id: 'src', x: 48, y: 64 }]);
    });
});

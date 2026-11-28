import { ref, computed, watch, type ComputedRef, type Ref } from 'vue';
import { useVueFlow, type Edge } from '@vue-flow/core';
import type { ConnectionState, EngineState } from '@/stores/engines';
import { pageResolver } from '@/utils/crossRefs';
import type { StubEdge } from '@/utils/crossRefTypes';
import { edgeColor, edgeStyle, IDLE_EDGE_COLOR } from '@/utils/edgeStyle';
import { stubEdge } from '@/utils/xrefCanvas';

/** The page's wires and tag stubs, from useCrossRefs (one derivation for the whole canvas). */
export interface EdgeRefs {
    direct: () => readonly ConnectionState[];
    stubs: () => readonly StubEdge[];
}

/**
 * Connection edges of the routing canvas, bound to <VueFlow :edges>. With
 * pages, `refs` gives the wires drawn on the current page (both ends there,
 * not a tag link; ADR-0030) and one stub per tag on it, between the module
 * port and the tag; a port can carry both (mixed wiring). Without, every
 * connection is a wire.
 *
 * n8n's pattern: built edges wait in a NON-reactive `pendingEdges` until
 * onNodesInitialized fires. Publishing edges before handles are mounted
 * causes Vue Flow to silently drop them. Nodes new to the canvas (a page
 * switch, a module added or moved here, a new tag) hold the edges again the
 * same way; the edges already drawn stay until then, so nothing blinks.
 */
export function useGraphEdges(
    engine: ComputedRef<EngineState | undefined>,
    focusMode: Ref<boolean>,
    focusedModules: ComputedRef<Set<string>>,
    isEdgeDimmed: (sourceModuleId: string, sinkModuleId: string) => boolean,
    currentPage?: () => string,
    refs?: EdgeRefs,
) {
    const { onNodesInitialized } = useVueFlow();
    const edges = ref<Edge[]>([]);
    let pendingEdges: Edge[] | null = null;
    let handlesInitialized = false;
    let shownModules = new Set<string>();

    /** Node ids drawn on the canvas: the page's modules and tags (a tag's node id is its key). */
    function modulesShown(): Set<string> {
        const ids = Object.keys(engine.value?.modules ?? {});
        const tags = refs?.stubs().map((s) => s.refKey) ?? [];
        const page = currentPage?.();
        if (page === undefined) return new Set([...ids, ...tags]);
        const pageFor = pageResolver(engine.value?.editor);
        return new Set([...ids.filter((id) => pageFor(id) === page), ...tags]);
    }

    function buildEdges(): Edge[] {
        const modules = engine.value?.modules;
        if (!modules) return [];
        const conns = refs ? refs.direct() : (engine.value?.connections ?? []);

        const engineRunning = engine.value?.running === true;

        const result: Edge[] = [];
        for (const conn of conns) {
            const srcModule = modules[conn.sourceModuleId];
            const sinkModule = modules[conn.sinkModuleId];
            if (!srcModule || !sinkModule) continue;
            const srcPort = srcModule.ports?.find((p) => p.id === conn.sourcePortId);
            const dimmed = isEdgeDimmed(conn.sourceModuleId, conn.sinkModuleId);
            // Only animate media that's actually flowing: the engine must be
            // running AND both endpoints of this connection must be running.
            const flowing = engineRunning && srcModule.running && sinkModule.running;
            // Idle connections also drop their stream-type colour, so a stopped
            // graph reads as grey wiring rather than live signal.
            const color = flowing ? edgeColor(srcPort?.streamType) : IDLE_EDGE_COLOR;
            const edge: Edge = {
                id: conn.id,
                source: conn.sourceModuleId,
                sourceHandle: conn.sourcePortId,
                target: conn.sinkModuleId,
                targetHandle: conn.sinkPortId,
                animated: flowing,
                interactionWidth: 20,
                style: edgeStyle(color, dimmed),
            };
            if (conn.label) {
                edge.label = conn.label;
                edge.labelStyle = { fill: 'var(--text-secondary)', fontSize: '10px' };
                edge.labelBgStyle = { fill: 'var(--bg-card)', fillOpacity: 0.9 };
                edge.labelBgPadding = [4, 2] as [number, number];
                edge.labelBgBorderRadius = 4;
            } else {
                edge.label = undefined;
                edge.labelStyle = undefined;
                edge.labelBgStyle = undefined;
                edge.labelBgPadding = undefined;
                edge.labelBgBorderRadius = undefined;
            }
            result.push(edge);
        }
        const byId = new Map((engine.value?.connections ?? []).map((c) => [c.id, c]));
        for (const stub of refs?.stubs() ?? []) {
            const dimmed = isEdgeDimmed(stub.moduleId, stub.moduleId);
            result.push(stubEdge(stub, { modules, byId, engineRunning, dimmed }));
        }
        return result;
    }

    function modulesOnPages(): string {
        const eng = engine.value;
        if (!eng) return '';
        const pageFor = pageResolver(eng.editor);
        return Object.keys(eng.modules)
            .sort()
            .map((id) => `${id}@${pageFor(id)}`)
            .join(',');
    }

    const edgeDeps = computed(() => ({
        conn:
            engine.value?.connections
                ?.map((c) => `${c.id}|${c.label ?? ''}`)
                .sort()
                .join(',') ?? '',
        // Every module with its page: a move or a page switch changes what is drawn.
        mods: modulesOnPages(),
        page: currentPage?.() ?? '',
        tagged: Object.keys(engine.value?.editor?.tagged ?? {})
            .sort()
            .join(','),
        stubs:
            refs
                ?.stubs()
                .map((s) => `${s.id}|${s.connectionIds.join('+')}`)
                .join(',') ?? '',
        // Edge `animated` tracks run state, so it has to be part of the
        // fingerprint — otherwise starting/stopping leaves stale animations.
        engineRunning: engine.value?.running === true,
        running: engine.value
            ? Object.values(engine.value.modules)
                  .filter((m) => m.running)
                  .map((m) => m.instanceId)
                  .sort()
                  .join(',')
            : '',
        focus: focusMode.value,
        focused: Array.from(focusedModules.value).sort().join(','),
    }));

    watch(
        edgeDeps,
        () => {
            const shown = modulesShown();
            if ([...shown].some((id) => !shownModules.has(id))) handlesInitialized = false;
            shownModules = shown;
            const built = buildEdges();
            if (handlesInitialized) {
                edges.value = built;
            } else {
                pendingEdges = built;
            }
        },
        { immediate: true },
    );

    // Flush held edges once Vue Flow confirms handles are mounted
    onNodesInitialized(() => {
        handlesInitialized = true;
        if (pendingEdges) {
            edges.value = pendingEdges;
            pendingEdges = null;
        }
    });

    return { edges };
}

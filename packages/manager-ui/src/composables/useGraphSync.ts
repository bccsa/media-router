import { computed, nextTick, type ComputedRef, type Ref } from 'vue';
import { useVueFlow, type Edge, type Node } from '@vue-flow/core';
import type { PatchOp } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { newModuleInstanceId } from '@/utils/ids';
import { computeAutoLayout } from '@/utils/autoLayout';
import { tagClearance, TAG_SIZE } from '@/utils/xrefCanvas';
import { STUB_EDGE_PREFIX } from '@/utils/crossRefTypes';
import { useGraphNodes } from '@/composables/useGraphNodes';
import { useGraphEdges } from '@/composables/useGraphEdges';
import { useGraphConnect } from '@/composables/useGraphConnect';
import { useGraphDrag, type NodeDragPayload } from '@/composables/useGraphDrag';
import { useCrossRefs } from '@/composables/useCrossRefs';
import { useXrefNodes } from '@/composables/useXrefNodes';
import type { Pages } from '@/composables/usePages';

/** The editor's pages (usePages); omitted = one canvas showing every module. */
export type GraphPages = Pick<Pages, 'currentPage' | 'pageOf' | 'selectPage' | 'newModuleOps'>;

/**
 * Declarative Vue Flow sync for the routing editor — composes the canvas parts:
 *   - useGraphNodes: module nodes of the current page, live drag positions, fitView
 *   - useCrossRefs + useXrefNodes: with pages, the page's cross-reference tags (ADR-0030)
 *   - useGraphEdges: the page's wires and tag stubs, held until handles mount (onNodesInitialized)
 *   - useGraphConnect: wire-drag validation and persistence; a wire dropped on
 *     empty canvas opens the link picker
 *   - useGraphDrag: drag tracking and position saves
 * plus edge delete, module add, focus and Format.
 */
export function useGraphSync(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusMode: Ref<boolean>,
    focusedModules: ComputedRef<Set<string>>,
    isEdgeDimmed: (sourceModuleId: string, sinkModuleId: string) => boolean,
    pages?: GraphPages,
) {
    const engineStore = useEngineStore();
    const { setCenter, screenToFlowCoordinate, findNode } = useVueFlow();
    const currentPage = pages ? () => pages.currentPage.value : undefined;
    const modules = useGraphNodes(engine, currentPage);
    const { hasInitialFit, activeDrags, fitView, keepViewOnPageChange } = modules;
    // Cross-reference tags come with pages; a tag dims with its module.
    const crossRefs = pages
        ? useCrossRefs(engineId, engine, pages, keepViewOnPageChange)
        : undefined;
    const tags = useXrefNodes(
        engine,
        () => crossRefs?.pageRefs.value ?? [],
        activeDrags,
        (moduleId) => isEdgeDimmed(moduleId, moduleId),
        () => crossRefs?.highlighted.value ?? null,
    );
    const nodes = computed<Node[]>(() => {
        const mods = modules.nodes.value as Node[];
        return tags.xrefNodes.value.length > 0 ? [...mods, ...tags.xrefNodes.value] : mods;
    });
    const { edges } = useGraphEdges(
        engine,
        focusMode,
        focusedModules,
        isEdgeDimmed,
        currentPage,
        crossRefs && {
            direct: () => crossRefs.pageDirect.value,
            stubs: () => crossRefs.pageStubs.value,
        },
    );
    const { isValidConnection, onConnect, onConnectStart, onConnectEnd } = useGraphConnect(
        engineId,
        engine,
        crossRefs &&
            ((origin, x, y) =>
                crossRefs.openLinkPicker(origin, x, y, screenToFlowCoordinate({ x, y }))),
    );
    const drag = useGraphDrag(engineId, activeDrags, crossRefs?.saveRefPositions);

    function onNodeDragStop(event: NodeDragPayload) {
        drag.onNodeDragStop(event);
        tags.afterDrag();
    }

    function onEdgeDelete(edgeId: string) {
        engineStore.removeConnection(engineId(), edgeId);
        patch.removeConnection(engineId(), edgeId);
    }

    function onAddModule(
        plugin: {
            pluginId: string;
            ports?: unknown[];
            configSchema?: Record<string, unknown>;
            color?: string;
            icon?: string;
            resizable?: unknown;
            interlock?: boolean;
            statusSections?: Array<Record<string, unknown>>;
            faceWidgets?: Array<Record<string, unknown>>;
        },
        displayName: string,
    ) {
        const instanceId = newModuleInstanceId(plugin.pluginId);
        const el = document.querySelector('.vue-flow') as HTMLElement | null;
        let x = 300,
            y = 200;
        if (el) {
            const rect = el.getBoundingClientRect();
            const center = screenToFlowCoordinate({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            });
            x = center.x - 100 + Math.random() * 40 - 20;
            y = center.y - 50 + Math.random() * 40 - 20;
        }
        const defaults: Record<string, unknown> = {};
        const props = (plugin.configSchema as any)?.properties;
        if (props) {
            for (const [key, schema] of Object.entries(props) as [string, any][]) {
                if (schema.default !== undefined) defaults[key] = schema.default;
            }
        }
        // Carry the manifest-derived fields through so the sender (who skips
        // the broadcast via N-1) sees the same shape that other browsers
        // receive from `enrichOpsForBroadcast`. Without `resizable` here, a
        // freshly-added note plugin has no resize grip until refresh.
        const value = {
            instanceId,
            pluginId: plugin.pluginId,
            displayName,
            position: { x, y },
            settings: defaults,
            ports: plugin.ports ?? [],
            configSchema: plugin.configSchema ?? {},
            color: plugin.color,
            icon: plugin.icon,
            resizable: plugin.resizable ?? false,
            interlock: plugin.interlock === true,
            statusSections: plugin.statusSections,
            faceWidgets: plugin.faceWidgets,
            enabled: true,
            running: false,
            health: 'stopped',
        };
        // One write: the module and, with real pages, its place on the page shown.
        patch.editor(engineId(), [
            { op: 'add', path: `/modules/${instanceId}`, value },
            ...(pages?.newModuleOps([instanceId]) ?? []),
        ]);
    }

    /** Centre on a module, switching to its page first. */
    function focusModule(moduleId: string) {
        const node = (nodes.value as Node[]).find((n) => n.id === moduleId);
        const pos = node?.position ?? engine.value?.modules[moduleId]?.position;
        const page = pages?.pageOf(moduleId);
        if (pages && page !== undefined && page !== pages.currentPage.value) {
            // Centring replaces the page's fit; with no position the fit shows the page.
            if (pos) keepViewOnPageChange();
            pages.selectPage(page);
            if (!pos) return;
        }
        if (pos) setCenter(pos.x + 100, pos.y + 40, { zoom: 1, duration: 300 });
        else fitView({ padding: 0.2 });
    }

    /**
     * Lay out the current page's modules; its dragged tags go back beside their
     * ports, with columns wide enough for a tag on each side.
     */
    function formatPage() {
        const wires = (edges.value as Edge[]).filter((e) => !e.id.startsWith(STUB_EDGE_PREFIX));
        const tags = crossRefs?.pageRefs.value ?? [];
        const widest = Math.max(
            TAG_SIZE.width,
            ...tags.map((t) => findNode(t.key)?.dimensions?.width ?? 0),
        );
        const positions = computeAutoLayout(modules.nodes.value as Node[], wires, {
            layerGap: tags.length > 0 ? tagClearance(widest) : undefined,
        });
        const ops: PatchOp[] = Array.from(positions, ([moduleId, value]) => ({
            op: 'replace' as const,
            path: `/modules/${moduleId}/position`,
            value,
        }));
        ops.push(...(crossRefs?.clearPositionOps() ?? []));
        if (ops.length === 0) return;
        patch.raw(engineId(), ops);
        // Vue Flow's coordinate cache lags the optimistic store update by a
        // microtask and a layout pass, so a single nextTick can fit stale bounds.
        nextTick(() => fitView({ padding: 0.2 }));
        setTimeout(() => fitView({ padding: 0.2 }), 200);
    }

    return {
        nodes,
        edges,
        hasInitialFit,
        fitView,
        isValidConnection,
        onConnect,
        onConnectStart,
        onConnectEnd,
        onNodeDragStart: drag.onNodeDragStart,
        onNodeDrag: tags.onNodeDrag,
        onNodeDragStop,
        onEdgeDelete,
        onAddModule,
        focusModule,
        formatPage,
        crossRefs,
    };
}

import { ref, computed, watch, nextTick, type ComputedRef, type Ref } from 'vue';
import { useVueFlow, type Node, type Edge, type Connection } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import { patch } from '@/composables/usePatch';

/** Edge colors by stream type — matches CSS variables in main.css. */
const STREAM_TYPE_COLORS: Record<string, string> = {
    'audio/pcm': '#3b82f6',
    'muxed/mpegts': '#f59e0b',
    'video/raw': '#10b981',
};

function edgeColor(streamType?: string): string {
    return STREAM_TYPE_COLORS[streamType ?? ''] ?? '#6b7280';
}

/**
 * Declarative Vue Flow sync:
 *   - `nodes` and `edges` are reactive refs, bound to <VueFlow :nodes :edges>
 *   - Edges are held in `pendingEdges` until onNodesInitialized fires (n8n pattern)
 *     — otherwise Vue Flow can't anchor them before handles mount.
 *   - `isValidConnection` is NOT passed to VueFlow as a prop (it was called during
 *     setEdges and dropped edges that hit maxConnections). Only used in onConnect.
 */
export function useGraphSync(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusMode: Ref<boolean>,
    focusedModules: ComputedRef<Set<string>>,
    isEdgeDimmed: (sourceModuleId: string, sinkModuleId: string) => boolean,
) {
    const socket = useSocketStore();
    const engineStore = useEngineStore();
    const { fitView, setCenter, screenToFlowCoordinate, onNodesInitialized } = useVueFlow();
    const hasInitialFit = ref(false);

    // --- Nodes: reactive ref bound via v-model:nodes ---

    const nodes = ref<Node[]>([]);

    // Track drags so server position updates don't overwrite user drags
    const activeDrags = new Set<string>();
    const recentDrags = new Map<string, number>();
    const DRAG_IGNORE_MS = 2000;

    // Rebuild nodes when module IDs change (add/remove).
    const moduleIds = computed(() => {
        if (!engine.value?.modules) return '';
        return Object.keys(engine.value.modules).sort().join(',');
    });

    watch(moduleIds, () => {
        const modules = engine.value?.modules;
        if (!modules) { nodes.value = []; return; }

        // Preserve positions from current nodes (user may have dragged)
        const currentPositions = new Map<string, { x: number; y: number }>();
        for (const n of nodes.value) {
            currentPositions.set(n.id, { ...n.position });
        }

        const newNodes: Node[] = Object.values(modules).map((mod) => ({
            id: mod.instanceId,
            type: 'module',
            position: currentPositions.get(mod.instanceId) ?? mod.position ?? { x: 100, y: 100 },
            data: mod,
        }));
        nodes.value = newNodes;

        if (!hasInitialFit.value && nodes.value.length > 0) {
            hasInitialFit.value = true;
            nextTick(() => fitView({ padding: 0.2 }));
            setTimeout(() => fitView({ padding: 0.2 }), 200);
        }
    }, { immediate: true });


    // Update node data + positions when module properties change.
    // Declarative mode: replace node objects in the array so Vue Flow re-reads.
    watch(() => engine.value?.modules, (modules) => {
        if (!modules) return;
        const now = Date.now();
        let changed = false;
        const updated: Node[] = (nodes.value as Node[]).map((node) => {
            const mod = modules[node.id];
            if (!mod) return node;
            const skipPosition = activeDrags.has(node.id)
                || (now - (recentDrags.get(node.id) ?? 0) < DRAG_IGNORE_MS);
            const newPos = skipPosition || !mod.position
                ? node.position
                : (node.position.x === mod.position.x && node.position.y === mod.position.y
                    ? node.position
                    : { ...mod.position });
            if (node.data !== mod || newPos !== node.position) {
                changed = true;
                return { ...node, data: mod, position: newPos };
            }
            return node;
        });
        if (changed) nodes.value = updated;
    }, { deep: true });

    // --- Edges: ref with deferred publish until handles are mounted ---
    //
    // n8n's pattern: hold pending edges in a NON-reactive `let` variable
    // until onNodesInitialized fires. Publishing edges before handles are
    // mounted causes Vue Flow to silently drop them.
    const edges = ref<Edge[]>([]);
    let pendingEdges: Edge[] | null = null;
    let handlesInitialized = false;

    function buildEdges(): Edge[] {
        const conns = engine.value?.connections ?? [];
        const modules = engine.value?.modules;
        if (!modules) return [];

        const result: Edge[] = [];
        for (const conn of conns) {
            if (!modules[conn.sourceModuleId] || !modules[conn.sinkModuleId]) continue;
            const srcPort = modules[conn.sourceModuleId]?.ports?.find((p) => p.id === conn.sourcePortId);
            const color = edgeColor(srcPort?.streamType);
            const dimmed = isEdgeDimmed(conn.sourceModuleId, conn.sinkModuleId);
            const edge: Edge = {
                id: conn.id,
                source: conn.sourceModuleId,
                sourceHandle: conn.sourcePortId,
                target: conn.sinkModuleId,
                targetHandle: conn.sinkPortId,
                animated: true,
                interactionWidth: 20,
                style: { stroke: color, opacity: dimmed ? 0.1 : 1, transition: 'opacity 0.2s ease' },
            };
            if (conn.label) {
                edge.label = conn.label;
                edge.labelStyle = { fill: 'var(--text-secondary)', fontSize: '10px' };
                edge.labelBgStyle = { fill: 'var(--bg-card)', fillOpacity: 0.9 };
                edge.labelBgPadding = [4, 2] as [number, number];
                edge.labelBgBorderRadius = 4;
            }
            result.push(edge);
        }
        return result;
    }

    const edgeDeps = computed(() => ({
        conn: engine.value?.connections?.map((c) => c.id).sort().join(',') ?? '',
        mods: engine.value ? Object.keys(engine.value.modules).sort().join(',') : '',
        focus: focusMode.value,
        focused: Array.from(focusedModules.value).sort().join(','),
    }));

    watch(edgeDeps, () => {
        const built = buildEdges();
        if (handlesInitialized) {
            edges.value = built;
        } else {
            pendingEdges = built;
        }
    }, { immediate: true });

    // Flush held edges once Vue Flow confirms handles are mounted
    onNodesInitialized(() => {
        handlesInitialized = true;
        if (pendingEdges) {
            edges.value = pendingEdges;
            pendingEdges = null;
        }
    });

    // --- Connection validation ---

    function isValidConnection(connection: Connection): boolean {
        const srcModule = engine.value?.modules[connection.source!];
        const tgtModule = engine.value?.modules[connection.target!];
        const srcPort = srcModule?.ports?.find((p) => p.id === connection.sourceHandle);
        const tgtPort = tgtModule?.ports?.find((p) => p.id === connection.targetHandle);
        if (!srcPort || !tgtPort) return false;

        const hasOutput = srcPort.direction === 'output' || tgtPort.direction === 'output';
        const hasInput = srcPort.direction === 'input' || tgtPort.direction === 'input';
        if (!hasOutput || !hasInput) return false;

        if (srcPort.streamType !== tgtPort.streamType) return false;

        const connections = engine.value?.connections ?? [];
        for (const port of [srcPort, tgtPort]) {
            const max = port.maxConnections ?? -1;
            if (max === 0) return false;
            if (max > 0) {
                const moduleId = port === srcPort ? connection.source! : connection.target!;
                const count = connections.filter((c) =>
                    (c.sourceModuleId === moduleId && c.sourcePortId === port.id) ||
                    (c.sinkModuleId === moduleId && c.sinkPortId === port.id)
                ).length;
                if (count >= max) return false;
            }
        }

        return true;
    }

    function onConnect(connection: Connection) {
        if (!isValidConnection(connection)) return;

        const srcModule = engine.value?.modules[connection.source!];
        const srcPort = srcModule?.ports?.find((p) => p.id === connection.sourceHandle);

        let outModule = connection.source!;
        let outPort = connection.sourceHandle!;
        let inModule = connection.target!;
        let inPort = connection.targetHandle!;

        if (srcPort?.direction === 'input') {
            outModule = connection.target!;
            outPort = connection.targetHandle!;
            inModule = connection.source!;
            inPort = connection.sourceHandle!;
        }

        const edgeId = `${outModule}:${outPort}-${inModule}:${inPort}`;
        // Just persist — the computed `edges` will reactively add the edge when
        // the store updates via socket response.
        patch.addConnection(engineId(), { id: edgeId, sourceModuleId: outModule, sourcePortId: outPort, sinkModuleId: inModule, sinkPortId: inPort });
    }

    function onNodeDragStart(event: { node: Node }) {
        activeDrags.add(event.node.id);
    }

    function onNodeDragStop(event: { node: Node }) {
        activeDrags.delete(event.node.id);
        recentDrags.set(event.node.id, Date.now());
        patch.modulePosition(engineId(), event.node.id, event.node.position);
    }

    function onEdgeDelete(edgeId: string) {
        engineStore.removeConnection(engineId(), edgeId);
        patch.removeConnection(engineId(), edgeId);
    }

    function onAddModule(plugin: { pluginId: string; ports?: unknown[]; configSchema?: Record<string, unknown>; color?: string; icon?: string }, displayName: string) {
        const instanceId = `${plugin.pluginId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const el = document.querySelector('.vue-flow') as HTMLElement | null;
        let x = 300, y = 200;
        if (el) {
            const rect = el.getBoundingClientRect();
            const center = screenToFlowCoordinate({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
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
        patch.addModule(engineId(), instanceId, {
            instanceId,
            pluginId: plugin.pluginId,
            displayName,
            position: { x, y },
            settings: defaults,
            ports: plugin.ports ?? [],
            configSchema: plugin.configSchema ?? {},
            color: plugin.color,
            icon: plugin.icon,
            enabled: true,
            running: false,
            health: 'stopped',
        });
    }

    function focusModule(moduleId: string) {
        const node = (nodes.value as Node[]).find((n) => n.id === moduleId);
        if (node) {
            setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1, duration: 300 });
        } else {
            const mod = engine.value?.modules[moduleId];
            if (mod?.position) setCenter(mod.position.x + 100, mod.position.y + 40, { zoom: 1, duration: 300 });
            else fitView({ padding: 0.2 });
        }
    }

    return {
        nodes,
        edges,
        hasInitialFit,
        fitView,
        isValidConnection,
        onConnect,
        onNodeDragStart,
        onNodeDragStop,
        onEdgeDelete,
        onAddModule,
        focusModule,
        edgeColor,
    };
}

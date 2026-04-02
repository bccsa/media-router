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

export function useGraphSync(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusMode: Ref<boolean>,
    focusedModules: ComputedRef<Set<string>>,
    isEdgeDimmed: (sourceModuleId: string, sinkModuleId: string) => boolean,
) {
    const socket = useSocketStore();
    const engineStore = useEngineStore();
    const { fitView, setNodes, setEdges, addEdges, removeEdges, zoomTo, setCenter, getNodes, getEdges, getViewport, screenToFlowCoordinate } = useVueFlow();
    const hasInitialFit = ref(false);

    // --- Node sync ---

    const moduleIds = computed(() => {
        if (!engine.value?.modules) return '';
        return Object.keys(engine.value.modules).sort().join(',');
    });

    watch(moduleIds, () => {
        const modules = engine.value?.modules;
        if (!modules) { setNodes([]); return; }

        const currentPositions = new Map<string, { x: number; y: number }>();
        for (const node of getNodes.value) {
            currentPositions.set(node.id, { ...node.position });
        }

        const newNodes: Node[] = Object.values(modules).map((mod) => ({
            id: mod.instanceId,
            type: 'module',
            position: currentPositions.get(mod.instanceId) ?? mod.position ?? { x: 100, y: 100 },
            data: mod,
        }));
        setNodes(newNodes);

        if (!hasInitialFit.value && newNodes.length > 0) {
            hasInitialFit.value = true;
            nextTick(() => fitView({ padding: 0.2 }));
            setTimeout(() => fitView({ padding: 0.2 }), 200);
        }
    }, { immediate: true });

    // Track which modules the user is dragging or recently dragged — ignore server position
    const activeDrags = new Set<string>(); // currently being dragged
    const recentDrags = new Map<string, number>(); // moduleId → timestamp of drag end
    const DRAG_IGNORE_MS = 2000; // ignore server position updates for 2s after drag end

    // Update node data in-place (doesn't trigger setNodes, preserves edges)
    watch(() => engine.value?.modules, (modules) => {
        if (!modules) return;
        const now = Date.now();
        for (const node of getNodes.value) {
            const mod = modules[node.id];
            if (!mod) continue;
            node.data = mod;
            // Skip position update if user is dragging or recently dragged this node
            if (activeDrags.has(node.id)) continue;
            const lastDrag = recentDrags.get(node.id);
            if (lastDrag && now - lastDrag < DRAG_IGNORE_MS) continue;
            if (mod.position && (node.position.x !== mod.position.x || node.position.y !== mod.position.y)) {
                node.position = { ...mod.position };
            }
        }
    }, { deep: true });

    // --- Edge sync ---

    const connectionKey = computed(() => {
        if (!engine.value?.connections) return '';
        return engine.value.connections.map((c) => c.id).sort().join(',');
    });

    watch([connectionKey, moduleIds, focusMode, focusedModules], () => {
        const connections = engine.value?.connections ?? [];

        const desired = new Map<string, Edge>();
        for (const conn of connections) {
            // Skip connections where source or target module doesn't exist
            if (!engine.value?.modules[conn.sourceModuleId] || !engine.value?.modules[conn.sinkModuleId]) continue;
            const srcModule = engine.value?.modules[conn.sourceModuleId];
            const srcPort = srcModule?.ports?.find((p) => p.id === conn.sourcePortId);
            const color = edgeColor(srcPort?.streamType);
            const dimmed = isEdgeDimmed(conn.sourceModuleId, conn.sinkModuleId);
            const edgeData: Edge = {
                id: conn.id,
                source: conn.sourceModuleId,
                sourceHandle: conn.sourcePortId,
                target: conn.sinkModuleId,
                targetHandle: conn.sinkPortId,
                animated: true,
                interactionWidth: 20,
                style: { stroke: color, opacity: dimmed ? 0.1 : 1, transition: 'opacity 0.2s ease' },
            };
            // Add label if the connection has one
            if (conn.label) {
                edgeData.label = conn.label;
                edgeData.labelStyle = { fill: 'var(--text-secondary)', fontSize: '10px' };
                edgeData.labelBgStyle = { fill: 'var(--bg-card)', fillOpacity: 0.9 };
                edgeData.labelBgPadding = [4, 2] as [number, number];
                edgeData.labelBgBorderRadius = 4;
            }
            desired.set(conn.id, edgeData);
        }

        const currentEdgeIds = new Set(getEdges.value.map(e => e.id));
        const desiredIds = new Set(desired.keys());

        const toRemove = [...currentEdgeIds].filter(id => !desiredIds.has(id));
        if (toRemove.length > 0) removeEdges(toRemove);

        const toAdd = [...desired.values()].filter(e => !currentEdgeIds.has(e.id));
        if (toAdd.length > 0) addEdges(toAdd);

        for (const edge of getEdges.value) {
            const d = desired.get(edge.id);
            if (d) {
                edge.style = d.style;
                edge.label = d.label ?? '';
                if (d.labelStyle) edge.labelStyle = d.labelStyle;
                if (d.labelBgStyle) edge.labelBgStyle = d.labelBgStyle;
            }
        }
    }, { immediate: true });

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
        const outMod = engine.value?.modules[outModule];
        const outP = outMod?.ports?.find((p) => p.id === outPort);
        const colour = edgeColor(outP?.streamType);

        addEdges([{ id: edgeId, source: outModule, sourceHandle: outPort, target: inModule, targetHandle: inPort, animated: true, interactionWidth: 20, style: { stroke: colour } }]);
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
        removeEdges([edgeId]);
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
        // Build default settings from configSchema
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
        const node = getNodes.value.find((n: Node) => n.id === moduleId);
        if (node) {
            setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1, duration: 300 });
        } else {
            const mod = engine.value?.modules[moduleId];
            if (mod?.position) setCenter(mod.position.x + 100, mod.position.y + 40, { zoom: 1, duration: 300 });
            else fitView({ padding: 0.2 });
        }
    }

    return {
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

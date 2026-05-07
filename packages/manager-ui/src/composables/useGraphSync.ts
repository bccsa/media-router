import { ref, computed, watch, nextTick, type ComputedRef, type Ref } from 'vue';
import { useVueFlow, type Node, type Edge, type Connection } from '@vue-flow/core';
import type { EngineState, ModuleState } from '@/stores/engines';
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
    const { fitView, setCenter, screenToFlowCoordinate, onNodesInitialized, findNode } =
        useVueFlow();
    const hasInitialFit = ref(false);

    // --- Nodes ---
    //
    // Position sources: `mod.position` is persistent (DB-backed); during an
    // active drag we read live position from `findNode(id).position` (Vue Flow's
    // internal store), NOT from `nodes.value` — its two-way sync with Vue Flow
    // lags by a microtask and was the source of the snap-back race.
    //
    // Per-node change detection preserves refs when nothing relevant changed,
    // so deep mutations (statusData / health / VU) don't churn the array.

    const nodes = ref<Node[]>([]);
    const activeDrags = new Set<string>();

    watch(
        () => engine.value?.modules,
        (modules) => {
            if (!modules) {
                nodes.value = [];
                return;
            }
            const prev = new Map((nodes.value as Node[]).map((n) => [n.id, n]));
            const incoming = Object.values(modules);
            let changed = incoming.length !== nodes.value.length;
            const next: Node[] = incoming.map((mod) => {
                const livePos = activeDrags.has(mod.instanceId)
                    ? findNode(mod.instanceId)?.position
                    : undefined;
                const desiredPos = livePos ?? mod.position ?? { x: 100, y: 100 };
                const old = prev.get(mod.instanceId);
                if (
                    old &&
                    old.data === mod &&
                    old.position.x === desiredPos.x &&
                    old.position.y === desiredPos.y
                ) {
                    return old;
                }
                changed = true;
                return { id: mod.instanceId, type: 'module', position: desiredPos, data: mod };
            });
            if (changed) nodes.value = next;

            if (!hasInitialFit.value && nodes.value.length > 0) {
                hasInitialFit.value = true;
                nextTick(() => fitView({ padding: 0.2 }));
                setTimeout(() => fitView({ padding: 0.2 }), 200);
            }
        },
        { deep: true, immediate: true },
    );

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
            const srcPort = modules[conn.sourceModuleId]?.ports?.find(
                (p) => p.id === conn.sourcePortId,
            );
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
                style: {
                    stroke: color,
                    opacity: dimmed ? 0.1 : 1,
                    transition: 'opacity 0.2s ease',
                },
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
        return result;
    }

    const edgeDeps = computed(() => ({
        conn:
            engine.value?.connections
                ?.map((c) => `${c.id}|${c.label ?? ''}`)
                .sort()
                .join(',') ?? '',
        mods: engine.value ? Object.keys(engine.value.modules).sort().join(',') : '',
        focus: focusMode.value,
        focused: Array.from(focusedModules.value).sort().join(','),
    }));

    watch(
        edgeDeps,
        () => {
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
                const count = connections.filter(
                    (c) =>
                        (c.sourceModuleId === moduleId && c.sourcePortId === port.id) ||
                        (c.sinkModuleId === moduleId && c.sinkPortId === port.id),
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
        patch.addConnection(engineId(), {
            id: edgeId,
            sourceModuleId: outModule,
            sourcePortId: outPort,
            sinkModuleId: inModule,
            sinkPortId: inPort,
        });
    }

    function onNodeDragStart(event: { node: Node }) {
        activeDrags.add(event.node.id);
    }

    function onNodeDragStop(event: { node: Node }) {
        activeDrags.delete(event.node.id);
        patch.modulePosition(engineId(), event.node.id, event.node.position);
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
        const instanceId = `${plugin.pluginId}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
            resizable: plugin.resizable ?? false,
            interlock: plugin.interlock === true,
            statusSections: plugin.statusSections,
            faceWidgets: plugin.faceWidgets,
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
            if (mod?.position)
                setCenter(mod.position.x + 100, mod.position.y + 40, { zoom: 1, duration: 300 });
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

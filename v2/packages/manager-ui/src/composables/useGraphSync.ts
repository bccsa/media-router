import { ref, computed, watch, nextTick, type ComputedRef, type Ref } from 'vue';
import { useVueFlow, type Node, type Edge, type Connection } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';

function edgeColor(streamType?: string): string {
    switch (streamType) {
        case 'audio/pcm': return '#3b82f6';
        case 'muxed/mpegts': return '#f59e0b';
        case 'video/raw': return '#10b981';
        default: return '#6b7280';
    }
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
    const { fitView, setNodes, setEdges, addEdges, removeEdges, zoomTo, setCenter, getNodes, getEdges } = useVueFlow();
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

    // Update node data in-place (doesn't trigger setNodes, preserves edges)
    watch(() => engine.value?.modules, (modules) => {
        if (!modules) return;
        for (const node of getNodes.value) {
            const mod = modules[node.id];
            if (!mod) continue;
            node.data = mod;
            if (mod.position && (node.position.x !== mod.position.x || node.position.y !== mod.position.y)) {
                node.position = { ...mod.position };
            }
        }
    }, { deep: true });

    // --- Edge sync ---

    const connectionKey = computed(() => {
        if (!engine.value?.connections) return '';
        return engine.value.connections.map((c: any) => c.id).sort().join(',');
    });

    watch([connectionKey, focusMode, focusedModules], () => {
        const connections = engine.value?.connections ?? [];

        const desired = new Map<string, any>();
        for (const conn of connections) {
            const srcModule = engine.value?.modules[(conn as any).sourceModuleId];
            const srcPort = srcModule?.ports?.find((p: any) => p.id === (conn as any).sourcePortId);
            const color = edgeColor(srcPort?.streamType ?? (conn as any).streamType);
            const dimmed = isEdgeDimmed((conn as any).sourceModuleId, (conn as any).sinkModuleId);
            desired.set((conn as any).id, {
                id: (conn as any).id,
                source: (conn as any).sourceModuleId,
                sourceHandle: (conn as any).sourcePortId,
                target: (conn as any).sinkModuleId,
                targetHandle: (conn as any).sinkPortId,
                animated: true,
                interactionWidth: 20,
                style: { stroke: color, opacity: dimmed ? 0.1 : 1, transition: 'opacity 0.2s ease' },
            });
        }

        const currentEdgeIds = new Set(getEdges.value.map(e => e.id));
        const desiredIds = new Set(desired.keys());

        const toRemove = [...currentEdgeIds].filter(id => !desiredIds.has(id));
        if (toRemove.length > 0) removeEdges(toRemove);

        const toAdd = [...desired.values()].filter(e => !currentEdgeIds.has(e.id));
        if (toAdd.length > 0) addEdges(toAdd);

        for (const edge of getEdges.value) {
            const d = desired.get(edge.id);
            if (d) edge.style = d.style;
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
            const max = (port as any).maxConnections ?? -1;
            if (max === 0) return false;
            if (max > 0) {
                const moduleId = port === srcPort ? connection.source! : connection.target!;
                const count = connections.filter((c: any) =>
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
        socket.emit('routing:connect', { engineId: engineId(), sourceModuleId: outModule, sourcePortId: outPort, sinkModuleId: inModule, sinkPortId: inPort });
    }

    function onNodeDragStop(event: { node: Node }) {
        socket.emit('module:position', { engineId: engineId(), moduleId: event.node.id, position: event.node.position });
    }

    function onEdgeDelete(edgeId: string) {
        removeEdges([edgeId]);
        engineStore.removeConnection(engineId(), edgeId);
        socket.emit('routing:disconnect', { engineId: engineId(), connectionId: edgeId });
    }

    function onAddModule(plugin: { pluginId: string }, displayName: string) {
        socket.emit('module:add', { engineId: engineId(), pluginId: plugin.pluginId, displayName, position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 } });
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
        onNodeDragStop,
        onEdgeDelete,
        onAddModule,
        focusModule,
        edgeColor,
    };
}

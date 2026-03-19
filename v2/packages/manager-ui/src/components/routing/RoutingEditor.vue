<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, provide } from 'vue';
import { VueFlow, useVueFlow, type Node, type Edge, type Connection } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import ModuleNode from './ModuleNode.vue';
import ModuleSettingsPanel from './ModuleSettingsPanel.vue';
import AddModulePanel from './AddModulePanel.vue';
import MrContextMenu, { type MenuItem } from '@/components/common/MrContextMenu.vue';
import MrButton from '@/components/common/MrButton.vue';
import LogViewer from './LogViewer.vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';

const props = defineProps<{ engineId: string }>();
provide('engineId', props.engineId);
const containerRef = ref<HTMLDivElement | null>(null);

// Prevent browser zoom — let Vue Flow handle it
function preventBrowserZoom(e: WheelEvent) { if (e.ctrlKey || e.metaKey) e.preventDefault(); }
onMounted(() => {
    containerRef.value?.addEventListener('wheel', preventBrowserZoom, { passive: false });
    // Tell manager to stream data for this engine only
    socket.emit('watch:engine', { engineId: props.engineId });
});
onUnmounted(() => {
    containerRef.value?.removeEventListener('wheel', preventBrowserZoom);
    // Stop streaming data for this engine
    socket.emit('watch:engine', { engineId: '' });
});

const engineStore = useEngineStore();
const socket = useSocketStore();

// When engineId changes, tell manager to stream this engine's data and reset UI state
watch(() => props.engineId, (id) => {
    socket.emit('watch:engine', { engineId: id });
    focusMode.value = false;
    focusedModules.value = new Set();
    hasInitialFit.value = false;
});
const { fitView, setNodes, setEdges, addEdges, removeEdges, zoomTo, setCenter, getNodes, getEdges } = useVueFlow();

const hasInitialFit = ref(false);
const focusMode = ref(false);
const focusedModules = ref(new Set<string>());
provide('focusMode', focusMode);
provide('focusedModules', focusedModules);
const showAddPanel = ref(false);
const showModuleList = ref(false);
const moduleListBtnRef = ref<any>(null);
const moduleListPos = ref({ x: 0, y: 0 });
const moduleSearch = ref('');
function toggleModuleList() {
    showModuleList.value = !showModuleList.value;
    if (showModuleList.value) {
        moduleSearch.value = '';
        if (moduleListBtnRef.value) {
            const el = moduleListBtnRef.value.$el ?? moduleListBtnRef.value;
            const rect = el?.getBoundingClientRect?.();
            if (rect) moduleListPos.value = { x: rect.left, y: rect.bottom + 4 };
        }
    }
}
const filteredModules = computed(() => {
    const mods = Object.values(engine.value?.modules || {});
    if (!moduleSearch.value) return mods;
    const q = moduleSearch.value.toLowerCase();
    return mods.filter((m) =>
        m.displayName?.toLowerCase().includes(q) ||
        m.pluginId?.toLowerCase().includes(q) ||
        m.instanceId?.toLowerCase().includes(q)
    );
});
const showLogs = ref(false);
const contextMenu = ref<{ x: number; y: number; moduleId: string } | null>(null);
const settingsPanel = ref<{ moduleId: string } | null>(null);

const engine = computed(() => engineStore.getEngine(props.engineId));

// --- Node sync (only when modules are added/removed) ---

const moduleIds = computed(() => {
    if (!engine.value?.modules) return '';
    return Object.keys(engine.value.modules).sort().join(',');
});

watch(moduleIds, () => {
    const modules = engine.value?.modules;
    if (!modules) { setNodes([]); return; }

    // Preserve Vue Flow's current positions
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
        // Sync position from store (multi-tab sync: another tab moved this module)
        if (mod.position && (node.position.x !== mod.position.x || node.position.y !== mod.position.y)) {
            node.position = { ...mod.position };
        }
    }
}, { deep: true });

// --- Edge sync (separate from nodes to avoid Vue Flow race) ---

const connectionKey = computed(() => {
    if (!engine.value?.connections) return '';
    return engine.value.connections.map((c: any) => c.id).sort().join(',');
});

watch([connectionKey, focusMode, focusedModules], () => {
    const connections = engine.value?.connections ?? [];
    const fm = focusMode.value;
    const focused = focusedModules.value;

    // Build desired edge map
    const desired = new Map<string, any>();
    for (const conn of connections) {
        const srcModule = engine.value?.modules[(conn as any).sourceModuleId];
        const srcPort = srcModule?.ports?.find((p: any) => p.id === (conn as any).sourcePortId);
        const color = edgeColor(srcPort?.streamType ?? (conn as any).streamType);
        const edgeDimmed = fm && focused.size > 0 &&
            !focused.has((conn as any).sourceModuleId) && !focused.has((conn as any).sinkModuleId);
        desired.set((conn as any).id, {
            id: (conn as any).id,
            source: (conn as any).sourceModuleId,
            sourceHandle: (conn as any).sourcePortId,
            target: (conn as any).sinkModuleId,
            targetHandle: (conn as any).sinkPortId,
            animated: true,
            interactionWidth: 20,
            style: { stroke: color, opacity: edgeDimmed ? 0.1 : 1, transition: 'opacity 0.2s ease' },
        });
    }

    // Diff against current Vue Flow edges
    const currentEdgeIds = new Set(getEdges.value.map(e => e.id));
    const desiredIds = new Set(desired.keys());

    // Remove edges that shouldn't exist
    const toRemove = [...currentEdgeIds].filter(id => !desiredIds.has(id));
    if (toRemove.length > 0) removeEdges(toRemove);

    // Add edges that are missing
    const toAdd = [...desired.values()].filter(e => !currentEdgeIds.has(e.id));
    if (toAdd.length > 0) addEdges(toAdd);

    // Update style on existing edges (for focus mode changes)
    for (const edge of getEdges.value) {
        const d = desired.get(edge.id);
        if (d) edge.style = d.style;
    }
}, { immediate: true });

// --- Event handlers ---

const edgeContextMenu = ref<{ x: number; y: number; edgeId: string } | null>(null);

function onEdgeClick(payload: any) {
    // On mobile (touch), show context menu on tap since there's no right-click
    const e = payload.event;
    const x = 'clientX' in e ? e.clientX : e.touches?.[0]?.clientX ?? 0;
    const y = 'clientY' in e ? e.clientY : e.touches?.[0]?.clientY ?? 0;
    edgeContextMenu.value = { x, y, edgeId: payload.edge.id };
    contextMenuOpenedAt = Date.now();
}

function onEdgeContextMenu(payload: any) {
    payload.event.preventDefault();
    const e = payload.event;
    const x = 'clientX' in e ? e.clientX : e.touches?.[0]?.clientX ?? 0;
    const y = 'clientY' in e ? e.clientY : e.touches?.[0]?.clientY ?? 0;
    edgeContextMenu.value = { x, y, edgeId: payload.edge.id };
}

function onEdgeContextAction(action: string) {
    if (action === 'delete' && edgeContextMenu.value) {
        const edgeId = edgeContextMenu.value.edgeId;
        // Remove from Vue Flow (visual)
        removeEdges([edgeId]);
        // Remove from Pinia store (prevents re-add when connectionKey watch fires)
        engineStore.removeConnection(props.engineId, edgeId);
        // Tell server to persist
        socket.emit('routing:disconnect', { engineId: props.engineId, connectionId: edgeId });
    }
    edgeContextMenu.value = null;
}

function edgeColor(streamType?: string): string {
    switch (streamType) {
        case 'audio/pcm': return '#3b82f6';
        case 'muxed/mpegts': return '#f59e0b';
        case 'video/raw': return '#10b981';
        default: return '#6b7280';
    }
}

/**
 * Validate connections: must be output→input of the same stream type.
 * Handles both drag directions (user can start drag from either side).
 */
function isValidConnection(connection: Connection): boolean {
    const srcModule = engine.value?.modules[connection.source!];
    const tgtModule = engine.value?.modules[connection.target!];
    const srcPort = srcModule?.ports?.find((p) => p.id === connection.sourceHandle);
    const tgtPort = tgtModule?.ports?.find((p) => p.id === connection.targetHandle);
    if (!srcPort || !tgtPort) return false;

    // Must be one output and one input
    const hasOutput = srcPort.direction === 'output' || tgtPort.direction === 'output';
    const hasInput = srcPort.direction === 'input' || tgtPort.direction === 'input';
    if (!hasOutput || !hasInput) return false;

    // Stream types must match
    if (srcPort.streamType !== tgtPort.streamType) return false;

    // Check maxConnections (0 = disabled, -1 = unlimited)
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

    // Normalise: ensure source is the output port, target is the input port
    const srcModule = engine.value?.modules[connection.source!];
    const srcPort = srcModule?.ports?.find((p) => p.id === connection.sourceHandle);

    let outModule = connection.source!;
    let outPort = connection.sourceHandle!;
    let inModule = connection.target!;
    let inPort = connection.targetHandle!;

    // If user dragged from input to output, swap
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
    socket.emit('routing:connect', { engineId: props.engineId, sourceModuleId: outModule, sourcePortId: outPort, sinkModuleId: inModule, sinkPortId: inPort });
}

function onNodeDragStop(event: { node: Node }) {
    socket.emit('module:position', { engineId: props.engineId, moduleId: event.node.id, position: event.node.position });
}

function onAddModule(plugin: { pluginId: string }, displayName: string) {
    socket.emit('module:add', { engineId: props.engineId, pluginId: plugin.pluginId, displayName, position: { x: 200 + Math.random() * 200, y: 100 + Math.random() * 200 } });
    showAddPanel.value = false;
}

// Context menu — use @node-context-menu on VueFlow (NOT composable)
let contextMenuOpenedAt = 0;
function onNodeContextMenu(payload: { event: MouseEvent | TouchEvent; node: Node }) {
    payload.event.preventDefault();
    const e = payload.event;
    const x = 'clientX' in e ? e.clientX : e.touches[0].clientX;
    const y = 'clientY' in e ? e.clientY : e.touches[0].clientY;
    contextMenu.value = { x, y, moduleId: payload.node.id };
    contextMenuOpenedAt = Date.now();
}
function openContextMenuFromTouch(id: string, e: TouchEvent) {
    const touch = e.touches[0] ?? e.changedTouches[0];
    if (touch) {
        contextMenu.value = { moduleId: id, x: touch.clientX, y: touch.clientY };
        contextMenuOpenedAt = Date.now();
    }
}
function dismissContextMenus() {
    // Ignore pane clicks within 300ms of opening (prevents touch race)
    if (Date.now() - contextMenuOpenedAt < 300) return;
    contextMenu.value = null;
    edgeContextMenu.value = null;
    showModuleList.value = false;
}

const contextMenuItems = computed<MenuItem[]>(() => {
    const mod = contextMenu.value ? engine.value?.modules[contextMenu.value.moduleId] : null;
    const isEnabled = mod?.enabled !== false;
    const moduleId = contextMenu.value?.moduleId ?? '';
    const isFocused = focusedModules.value.has(moduleId);
    // SVG inner content for icons (stroke-based, 24x24 viewBox)
    const iconRestart = '<polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />';
    const iconSettings = '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';
    const iconClone = '<rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />';
    const iconDisable = '<circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />';
    const iconEnable = '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />';
    const iconFocus = '<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />';
    const iconDelete = '<polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />';

    return [
        { label: 'Restart', action: 'restart', icon: iconRestart },
        { label: 'Settings', action: 'settings', icon: iconSettings },
        { label: 'Clone', action: 'clone', icon: iconClone },
        { label: '', action: '', divider: true },
        isEnabled
            ? { label: 'Disable', action: 'disable', icon: iconDisable }
            : { label: 'Enable', action: 'enable', icon: iconEnable },
        { label: '', action: '', divider: true },
        isFocused
            ? { label: 'Default', action: 'unfocus', icon: iconFocus }
            : { label: 'Focus', action: 'focus', icon: iconFocus },
        { label: '', action: '', divider: true },
        { label: 'Delete', action: 'delete', danger: true, icon: iconDelete },
    ];
});

function onContextAction(action: string) {
    if (!contextMenu.value) return;
    const moduleId = contextMenu.value.moduleId;
    switch (action) {
        case 'restart': socket.emit('module:restart', { engineId: props.engineId, moduleId }); break;
        case 'settings': settingsPanel.value = { moduleId }; break;
        case 'clone': {
            const mod = engine.value?.modules[moduleId];
            if (mod) {
                socket.emit('module:add', {
                    engineId: props.engineId,
                    pluginId: mod.pluginId,
                    displayName: mod.displayName + ' (copy)',
                    position: { x: (mod.position?.x ?? 100) + 50, y: (mod.position?.y ?? 100) + 50 },
                    settings: { ...mod.settings },
                });
            }
            break;
        }
        case 'enable': socket.emit('module:toggle', { engineId: props.engineId, moduleId, enabled: true }); break;
        case 'disable': socket.emit('module:toggle', { engineId: props.engineId, moduleId, enabled: false }); break;
        case 'focus': {
            const s = new Set(focusedModules.value);
            s.add(moduleId);
            focusedModules.value = s;
            break;
        }
        case 'unfocus': {
            const s = new Set(focusedModules.value);
            s.delete(moduleId);
            focusedModules.value = s;
            // If no modules are focused, auto-disable focus mode
            if (s.size === 0) focusMode.value = false;
            break;
        }
        case 'delete': socket.emit('module:delete', { engineId: props.engineId, moduleId }); break;
    }
    contextMenu.value = null;
}

function focusModule(moduleId: string) {
    const node = getNodes.value.find((n: Node) => n.id === moduleId);
    if (node) { setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1, duration: 300 }); }
    else {
        const mod = engine.value?.modules[moduleId];
        if (mod?.position) setCenter(mod.position.x + 100, mod.position.y + 40, { zoom: 1, duration: 300 });
        else fitView({ padding: 0.2 });
    }
    showModuleList.value = false;
}

function resetView() { setCenter(0, 0, { zoom: 1 }); }
</script>

<template>
    <div ref="containerRef" class="w-full h-full relative flex flex-col">
        <!-- Toolbar -->
        <div class="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 overflow-x-auto no-scrollbar toolbar-h">
            <!-- Engine start/stop -->
            <MrButton v-if="engine?.running" size="sm" variant="danger"
                      @click="socket.emit('engine:stop', { engineId: props.engineId })">
                Stop
            </MrButton>
            <MrButton v-else size="sm"
                      @click="socket.emit('engine:start', { engineId: props.engineId })">
                Start
            </MrButton>

            <!-- Engine name + settings link -->
            <RouterLink :to="`/engines/${props.engineId}`"
                        class="flex items-center justify-center rounded-md transition-colors"
                        :style="{ color: 'var(--text-muted)', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', width: '32px' }"
                        title="Engine settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
            </RouterLink>

            <div class="w-px h-5" :style="{ backgroundColor: 'var(--border-primary)' }" />

            <MrButton size="sm" @click="showAddPanel = !showAddPanel">+ Add Module</MrButton>
            <MrButton size="sm" variant="secondary" @click="fitView({ padding: 0.2 })">Fit View</MrButton>
            <MrButton size="sm" variant="secondary" @click="showLogs = !showLogs">Logs</MrButton>
            <MrButton size="sm" :variant="focusMode ? 'primary' : 'secondary'" @click="focusMode = !focusMode">
                {{ focusMode ? 'Focus' : 'Focus' }}
            </MrButton>

            <!-- Module finder -->
            <div class="relative">
                <MrButton ref="moduleListBtnRef" size="sm" variant="secondary" @click="toggleModuleList">
                    Modules ({{ Object.keys(engine?.modules || {}).length }})
                </MrButton>
                <Teleport to="body">
                    <div v-if="showModuleList" class="fixed inset-0 z-[998]" @click="showModuleList = false" />
                    <div v-if="showModuleList" class="fixed w-56 rounded-lg shadow-xl z-[999] flex flex-col"
                         :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', top: moduleListPos.y + 'px', left: moduleListPos.x + 'px', maxHeight: '280px' }">
                        <div class="px-2 py-1.5 shrink-0" :style="{ borderBottom: '1px solid var(--border-secondary)' }">
                            <input v-model="moduleSearch" placeholder="Search modules..."
                                   class="w-full px-2 py-1 text-xs rounded-md"
                                   :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }" />
                        </div>
                        <div class="overflow-y-auto py-1">
                            <div v-if="filteredModules.length === 0" class="px-3 py-2 text-xs" :style="{ color: 'var(--text-muted)' }">No modules found</div>
                            <button v-for="mod in filteredModules" :key="mod.instanceId"
                                    @click="focusModule(mod.instanceId)"
                                    class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2" :style="{ color: 'var(--text-primary)' }">
                                <div class="w-2 h-2 rounded-full shrink-0" :style="{ backgroundColor: mod.health === 'ok' ? 'var(--health-ok)' : mod.health === 'error' ? 'var(--health-error)' : 'var(--health-stopped)' }" />
                                {{ mod.displayName }}
                                <span class="text-[10px] ml-auto" :style="{ color: 'var(--text-muted)' }">{{ mod.pluginId }}</span>
                            </button>
                        </div>
                    </div>
                </Teleport>
            </div>
        </div>

        <VueFlow class="flex-1" :snap-to-grid="true" :snap-grid="[16, 16]" :min-zoom="0.2" :max-zoom="2" :default-zoom="1"
                 fit-view-on-init :is-valid-connection="isValidConnection"
                 @connect="onConnect" @edge-click="onEdgeClick" @edge-context-menu="onEdgeContextMenu"
                 @node-context-menu="onNodeContextMenu" @node-drag-stop="onNodeDragStop"
                 @pane-click="dismissContextMenus">
            <template #node-module="{ data, id }">
                <ModuleNode :data="data" @dblclick="settingsPanel = { moduleId: id }"
                            @longpress="(e: TouchEvent) => openContextMenuFromTouch(id, e)" />
            </template>
        </VueFlow>

        <!-- Log drawer -->
        <div v-if="showLogs" class="shrink-0 border-t"
             :style="{ height: '250px', borderColor: 'var(--border-primary)', backgroundColor: 'var(--bg-card)' }">
            <div class="flex items-center justify-between px-3 py-1" :style="{ borderBottom: '1px solid var(--border-secondary)' }">
                <span class="text-[10px] font-semibold uppercase tracking-wider" :style="{ color: 'var(--text-muted)' }">Engine Logs</span>
                <button @click="showLogs = false" class="p-0.5 rounded" :style="{ color: 'var(--text-muted)' }">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </div>
            <LogViewer :engine-id="engineId" style="height: calc(100% - 28px);" />
        </div>

        <AddModulePanel v-if="showAddPanel" @close="showAddPanel = false" @add="onAddModule" />

        <MrContextMenu v-if="contextMenu" :items="contextMenuItems" :x="contextMenu.x" :y="contextMenu.y"
                       @action="onContextAction" @close="contextMenu = null" />

        <MrContextMenu v-if="edgeContextMenu"
                       :items="[{ label: 'Delete Connection', action: 'delete', danger: true, icon: '<polyline points=&quot;3 6 5 6 21 6&quot; /><path d=&quot;M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6&quot; /><path d=&quot;M10 11v6&quot; /><path d=&quot;M14 11v6&quot; />' }]"
                       :x="edgeContextMenu.x" :y="edgeContextMenu.y"
                       @action="onEdgeContextAction" @close="edgeContextMenu = null" />

        <ModuleSettingsPanel v-if="settingsPanel" :engine-id="engineId" :module-id="settingsPanel.moduleId"
                             @close="settingsPanel = null" />
    </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.toolbar-h > * { height: 32px; flex-shrink: 0; }
.toolbar-h > .w-px { height: 20px; }
</style>

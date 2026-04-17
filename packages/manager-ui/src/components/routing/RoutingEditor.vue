<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, provide } from 'vue';
import { VueFlow } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import ModuleNode from './ModuleNode.vue';
import ModuleSettingsPanel from './ModuleSettingsPanel.vue';
import AddModulePanel from './AddModulePanel.vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';
import MrButton from '@/components/common/MrButton.vue';
import MrTooltip from '@/components/common/MrTooltip.vue';
import LogViewer from './LogViewer.vue';
import ChannelMapEditor from './ChannelMapEditor.vue';
import EdgeLabelEditor from './EdgeLabelEditor.vue';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import { useFocusMode } from '@/composables/useFocusMode';
import { useContextMenu } from '@/composables/useContextMenu';
import { useGraphSync } from '@/composables/useGraphSync';
import { patch } from '@/composables/usePatch';

const props = defineProps<{ engineId: string }>();
provide('engineId', props.engineId);

const socket = useSocketStore();
const engineStore = useEngineStore();
const engine = computed(() => engineStore.getEngine(props.engineId));

// --- Composables ---
const { focusMode, focusedModules, setModuleFocused, isEdgeDimmed, provideToChildren } = useFocusMode(engine);
provideToChildren();

const {
    contextMenu, edgeContextMenu, settingsPanel, contextMenuItems,
    edgeMenuItems, editingEdgeLabel, channelMapEdge,
    onNodeContextMenu, openContextMenuFromTouch, dismissContextMenus,
    onContextAction, onEdgeClick, onEdgeContextMenu,
    onEdgeContextAction, saveEdgeLabel,
} = useContextMenu(() => props.engineId, engine, focusedModules, setModuleFocused);

const {
    nodes, edges,
    hasInitialFit, fitView, onConnect,
    onNodeDragStart, onNodeDragStop, onEdgeDelete, onAddModule: graphAddModule, focusModule: graphFocusModule,
} = useGraphSync(() => props.engineId, engine, focusMode, focusedModules, isEdgeDimmed);

// --- Local UI state ---
const containerRef = ref<HTMLDivElement | null>(null);
const showAddPanel = ref(false);
const showModuleList = ref(false);
const showLogs = ref(false);
const showResetConfirm = ref(false);

function confirmReset() {
    showResetConfirm.value = false;
    socket.emit('engine:reset', { engineId: props.engineId });
}

// Throttled slider change from context menu (volume, etc.)
let ctxSliderTimer: ReturnType<typeof setTimeout> | null = null;
let ctxSliderPending: { action: string; value: number } | null = null;
function onContextSliderChange(action: string, value: number) {
    if (!contextMenu.value || !action.startsWith('setting:')) return;
    const key = action.replace('setting:', '');
    const moduleId = contextMenu.value.moduleId;
    ctxSliderPending = { action, value };
    if (!ctxSliderTimer) {
        patch.moduleSetting(props.engineId, moduleId, key, value);
        ctxSliderTimer = setTimeout(() => {
            ctxSliderTimer = null;
            if (ctxSliderPending) {
                const k = ctxSliderPending.action.replace('setting:', '');
                patch.moduleSetting(props.engineId, moduleId, k, ctxSliderPending.value);
                ctxSliderPending = null;
            }
        }, 100);
    }
}

function onContextToggleChange(action: string, value: boolean) {
    if (!contextMenu.value || !action.startsWith('setting:')) return;
    const key = action.replace('setting:', '');
    const moduleId = contextMenu.value.moduleId;
    patch.moduleSetting(props.engineId, moduleId, key, value);
}

const moduleListBtnRef = ref<any>(null);
const moduleListPos = ref({ x: 0, y: 0 });
const moduleSearch = ref('');

// --- Browser zoom prevention ---
function preventBrowserZoom(e: WheelEvent) { if (e.ctrlKey || e.metaKey) e.preventDefault(); }
onMounted(() => {
    containerRef.value?.addEventListener('wheel', preventBrowserZoom, { passive: false });
    socket.emit('watch:engine', { engineId: props.engineId });
});
onUnmounted(() => {
    containerRef.value?.removeEventListener('wheel', preventBrowserZoom);
    socket.emit('watch:engine', { engineId: '' });
});

// When engineId changes, reset UI state
watch(() => props.engineId, (id) => {
    socket.emit('watch:engine', { engineId: id });
    focusMode.value = false;
    hasInitialFit.value = false;
});

// Re-subscribe on Socket.IO reconnect (VU/logs stop without this)
watch(() => socket.connected, (isConnected) => {
    if (isConnected && props.engineId) {
        socket.emit('watch:engine', { engineId: props.engineId });
    }
});

// --- Module list dropdown ---
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

// --- Module add ---
function onAddModule(plugin: { pluginId: string }, displayName: string) {
    graphAddModule(plugin, displayName);
    showAddPanel.value = false;
}

// --- Edge context action wrapper (passes onEdgeDelete) ---
function handleEdgeAction(action: string) {
    onEdgeContextAction(action, onEdgeDelete);
}

// --- Module list focus ---
function focusModule(moduleId: string) {
    graphFocusModule(moduleId);
    showModuleList.value = false;
}

// --- Dismiss all menus on pane click ---
function dismissAll() {
    dismissContextMenus();
    showModuleList.value = false;
}
</script>

<template>
    <div ref="containerRef" class="w-full h-full relative flex flex-col">
        <!-- Toolbar -->
        <div class="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap no-scrollbar toolbar-h">
            <!-- Engine start/stop -->
            <MrTooltip :text="engine?.running ? 'Stop all running modules' : 'Start all modules on this engine'">
                <MrButton v-if="engine?.running" size="sm" variant="danger"
                          @click="socket.emit('engine:stop', { engineId: props.engineId })">
                    Stop
                </MrButton>
                <MrButton v-else size="sm"
                          @click="socket.emit('engine:start', { engineId: props.engineId })">
                    Start
                </MrButton>
            </MrTooltip>

            <MrTooltip text="Stop all modules, restart PipeWire, and restart modules" width="w-52">
                <MrButton size="sm" variant="secondary" @click="showResetConfirm = true">Reset</MrButton>
            </MrTooltip>

            <!-- Engine settings link -->
            <MrTooltip text="Engine settings and profiles" width="w-44">
                <RouterLink :to="`/engines/${props.engineId}`"
                            class="flex items-center justify-center rounded-md transition-colors text-muted bg-card border border-border w-8 h-8">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                </RouterLink>
            </MrTooltip>

            <div class="w-px h-5 bg-border" />

            <MrTooltip text="Add a new module (encoder, decoder, input, output)" width="w-52">
                <MrButton size="sm" @click="showAddPanel = !showAddPanel; settingsPanel = null">+ Add Module</MrButton>
            </MrTooltip>
            <MrTooltip text="Zoom to fit all modules in view" width="w-44">
                <MrButton size="sm" variant="secondary" @click="fitView({ padding: 0.2 })">Fit View</MrButton>
            </MrTooltip>
            <MrTooltip :text="showLogs ? 'Hide engine log viewer' : 'Show engine log viewer'" width="w-44">
                <MrButton size="sm" variant="secondary" @click="showLogs = !showLogs">Logs</MrButton>
            </MrTooltip>
            <MrTooltip :text="focusMode ? 'Exit focus mode — show all modules' : 'Enter focus mode — dim non-focused modules'" width="w-52">
                <MrButton size="sm" :variant="focusMode ? 'primary' : 'secondary'" @click="focusMode = !focusMode">
                    Focus
                </MrButton>
            </MrTooltip>

            <!-- Module finder -->
            <MrTooltip text="Click to list all modules — click a module to jump to it">
                <MrButton ref="moduleListBtnRef" size="sm" variant="secondary" @click="toggleModuleList">
                    Modules ({{ Object.keys(engine?.modules || {}).length }})
                </MrButton>
                <Teleport to="body">
                    <div v-if="showModuleList" class="fixed inset-0 z-[998]" @click="showModuleList = false" />
                    <div v-if="showModuleList" class="fixed w-56 rounded-lg shadow-xl z-[999] flex flex-col bg-card border border-border"
                         :style="{ top: moduleListPos.y + 'px', left: moduleListPos.x + 'px', maxHeight: '280px' }">
                        <div class="px-2 py-1.5 shrink-0 border-b border-border-alt">
                            <input v-model="moduleSearch" placeholder="Search modules..."
                                   class="w-full px-2 py-1 text-xs rounded-md bg-input border border-border text-foreground" />
                        </div>
                        <div class="overflow-y-auto py-1">
                            <div v-if="filteredModules.length === 0" class="px-3 py-2 text-xs text-muted">No modules found</div>
                            <button v-for="mod in filteredModules" :key="mod.instanceId"
                                    @click="focusModule(mod.instanceId)"
                                    class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground">
                                <div class="w-2 h-2 rounded-full shrink-0" :class="mod.health === 'ok' ? 'bg-ok' : mod.health === 'error' ? 'bg-error' : 'bg-stopped'" />
                                {{ mod.displayName }}
                                <span class="text-[10px] ml-auto text-muted">{{ mod.pluginId }}</span>
                            </button>
                        </div>
                    </div>
                </Teleport>
            </MrTooltip>
        </div>

        <VueFlow class="flex-1" :nodes="nodes" :edges="edges"
                 :snap-to-grid="true" :snap-grid="[16, 16]" :min-zoom="0.2" :max-zoom="2" :default-zoom="1"
                 fit-view-on-init
                 @connect="onConnect" @edge-click="onEdgeClick" @edge-context-menu="onEdgeContextMenu"
                 @node-context-menu="onNodeContextMenu" @node-drag-start="onNodeDragStart" @node-drag-stop="onNodeDragStop"
                 @pane-click="dismissAll">
            <template #node-module="{ data, id }">
                <ModuleNode :data="data" @dblclick="settingsPanel = { moduleId: id }"
                            @longpress="(e: TouchEvent) => openContextMenuFromTouch(id, e)" />
            </template>
        </VueFlow>

        <!-- Log drawer -->
        <div v-if="showLogs" class="shrink-0 border-t border-border bg-card" style="height: 250px">
            <div class="flex items-center justify-between px-3 py-1 border-b border-border-alt">
                <span class="text-[10px] font-semibold uppercase tracking-wider text-muted">Engine Logs</span>
                <button @click="showLogs = false" class="p-0.5 rounded text-muted">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
            </div>
            <LogViewer :engine-id="engineId" style="height: calc(100% - 28px);" />
        </div>

        <AddModulePanel v-if="showAddPanel" @close="showAddPanel = false" @add="onAddModule" />

        <MrContextMenu v-if="contextMenu" :items="contextMenuItems" :x="contextMenu.x" :y="contextMenu.y"
                       @action="onContextAction" @slider-change="onContextSliderChange" @toggle-change="onContextToggleChange" @close="contextMenu = null" />

        <MrContextMenu v-if="edgeContextMenu"
                       :items="edgeMenuItems"
                       :x="edgeContextMenu.x" :y="edgeContextMenu.y"
                       @action="handleEdgeAction" @close="edgeContextMenu = null" />

        <!-- Edge label editor -->
        <EdgeLabelEditor v-if="editingEdgeLabel"
                         :label="editingEdgeLabel.label"
                         @save="(l: string) => { editingEdgeLabel!.label = l; saveEdgeLabel(); }"
                         @close="editingEdgeLabel = null" />

        <ModuleSettingsPanel v-if="settingsPanel" :engine-id="engineId" :module-id="settingsPanel.moduleId"
                             @close="settingsPanel = null" />

        <!-- Channel Map Editor -->
        <ChannelMapEditor v-if="channelMapEdge"
                          :engine-id="engineId"
                          :connection-id="channelMapEdge"
                          @close="channelMapEdge = null" />

        <!-- Reset confirmation -->
        <Teleport to="body">
            <div v-if="showResetConfirm" class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.5)">
                <div class="rounded-lg shadow-xl p-5 max-w-sm w-full mx-4 bg-card border border-border">
                    <h3 class="text-base font-semibold mb-2 text-foreground">Reset Engine?</h3>
                    <p class="text-sm mb-4 text-subtle">
                        This will stop all modules, restart PipeWire, and restart all modules. Audio will be interrupted for a few seconds.
                    </p>
                    <div class="flex justify-end gap-2">
                        <MrButton size="sm" variant="secondary" @click="showResetConfirm = false">Cancel</MrButton>
                        <MrButton size="sm" variant="danger" @click="confirmReset">Reset</MrButton>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.toolbar-h > * { height: 32px; flex-shrink: 0; }
.toolbar-h > .w-px { height: 20px; }
</style>

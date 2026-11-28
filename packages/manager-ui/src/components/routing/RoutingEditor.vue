<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted, provide } from 'vue';
import { VueFlow } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import ModuleNode from './ModuleNode.vue';
import XrefNode from './XrefNode.vue';
import RoutingToolbar from './RoutingToolbar.vue';
import RoutingOverlays, { type RoutingUi } from './RoutingOverlays.vue';
import PageTabs from './PageTabs.vue';
import { useEngineStore } from '@/stores/engines';
import { useTopics } from '@/composables/useTopics';
import { useFocusMode } from '@/composables/useFocusMode';
import { useContextMenu } from '@/composables/useContextMenu';
import { useGraphSync } from '@/composables/useGraphSync';
import { usePages } from '@/composables/usePages';
import { useMultiSelect } from '@/composables/useMultiSelect';
import { useXrefUi } from '@/composables/useXrefUi';
import { panActivationKey } from '@/utils/panKey';

const props = defineProps<{ engineId: string }>();
provide('engineId', props.engineId);

const engineStore = useEngineStore();
const engine = computed(() => engineStore.getEngine(props.engineId));

// --- Composables ---
const { focusMode, focusedModules, isEdgeDimmed, provideToChildren } = useFocusMode(engine);
provideToChildren();

// Pages (ADR-0030): the canvas shows the current page's modules, wires and cross-reference tags.
const pages = usePages(() => props.engineId);
const { tabs: pageTabs, currentPage } = pages;

const {
    nodes,
    edges,
    hasInitialFit,
    fitView,
    onConnect,
    onConnectStart,
    onConnectEnd,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onEdgeDelete,
    onAddModule: graphAddModule,
    focusModule: graphFocusModule,
    formatPage,
    crossRefs,
} = useGraphSync(() => props.engineId, engine, focusMode, focusedModules, isEdgeDimmed, pages);

// --- Local UI state ---
const containerRef = ref<HTMLDivElement | null>(null);
const overlays = ref<InstanceType<typeof RoutingOverlays> | null>(null);
const ui = reactive<RoutingUi>({
    showAddPanel: false,
    showModuleList: false,
    showLogs: false,
    showResetConfirm: false,
    showInterlocks: false,
});

// Both wrapped in `reactive` so the toolbar and overlays read and write them as plain fields.
const multi = reactive(
    useMultiSelect({
        engineId: () => props.engineId,
        engine,
        container: containerRef,
        isBlocked: () => overlays.value?.isBlocked() ?? false,
        onEdgeDelete: (id) => onEdgeDelete(id),
        openGroupMenu: (ids, x, y) => menu.openGroupMenuAt(x, y, ids),
    }),
);

const menu = reactive(
    useContextMenu(
        () => props.engineId,
        engine,
        focusedModules,
        {
            selectedIds: multi.selectedNodeIds,
            requestDelete: (ids) => multi.requestDelete(ids),
        },
        pages,
        {
            openTagMenu: (key, x, y) => xref.openTagMenu(key, x, y),
            setTagged: (id, on) => xref.setTagged(id, on),
        },
    ),
);

// Cross-reference tags: dropdown and side panel; their links reuse the wire's editors.
// useGraphSync makes crossRefs whenever pages are given, as they are here.
const xref = reactive(
    useXrefUi(engine, crossRefs!, {
        channelMap: (id) => (menu.channelMapEdge = id),
        editLabel: (id) => {
            const label = engine.value?.connections.find((c) => c.id === id)?.label ?? '';
            menu.editingEdgeLabel = { edgeId: id, label };
        },
        openModule: (id) => {
            graphFocusModule(id);
            menu.settingsPanel = { moduleId: id };
        },
        closeModulePanel: () => (menu.settingsPanel = null),
    }),
);
// One side panel at a time: a module's settings replace a tag's panel.
watch(
    () => menu.settingsPanel,
    (panel) => panel && (xref.xrefPanel = null),
);

// --- Browser zoom prevention ---
function preventBrowserZoom(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
}
onMounted(() => {
    containerRef.value?.addEventListener('wheel', preventBrowserZoom, { passive: false });
});
onUnmounted(() => {
    containerRef.value?.removeEventListener('wheel', preventBrowserZoom);
});

// The whole engine — graph, runtime, VU, logs, devices — while the editor shows it.
useTopics(() => [`/engines/${props.engineId}`]);

// When engineId changes, reset UI state
watch(
    () => props.engineId,
    () => {
        focusMode.value = false;
        hasInitialFit.value = false;
    },
);

function toggleAddPanel() {
    ui.showAddPanel = !ui.showAddPanel;
    menu.settingsPanel = null;
}

function onAddModule(plugin: { pluginId: string }, displayName: string) {
    graphAddModule(plugin, displayName);
    ui.showAddPanel = false;
}

// --- Dismiss all menus on pane click ---
function dismissAll() {
    menu.dismissContextMenus();
    ui.showModuleList = false;
}
</script>

<template>
    <div ref="containerRef" class="w-full h-full relative flex flex-col">
        <RoutingToolbar
            v-model:focus-mode="focusMode"
            v-model:select-mode="multi.selectMode"
            :engine-id="engineId"
            :engine="engine"
            :ui="ui"
            :selected-count="multi.selectedCount"
            @toggle-add="toggleAddPanel"
            @fit="fitView({ padding: 0.2 })"
            @format="formatPage"
            @focus-module="graphFocusModule"
        />

        <VueFlow
            class="flex-1"
            :nodes="nodes"
            :edges="edges"
            :snap-to-grid="true"
            :snap-grid="[16, 16]"
            :min-zoom="0.2"
            :max-zoom="2"
            :default-zoom="1"
            fit-view-on-init
            :delete-key-code="null"
            :selection-key-code="multi.selectMode ? true : 'Shift'"
            :multi-selection-key-code="multi.selectMode ? true : ['Meta', 'Control']"
            :pan-on-drag="!multi.selectMode"
            :pan-activation-key-code="panActivationKey"
            @connect="onConnect"
            @connect-start="onConnectStart"
            @connect-end="onConnectEnd"
            @edge-click="menu.onEdgeClick"
            @edge-context-menu="menu.onEdgeContextMenu"
            @node-context-menu="menu.onNodeContextMenu"
            @selection-context-menu="menu.onSelectionContextMenu"
            @node-drag-start="onNodeDragStart"
            @node-drag="onNodeDrag"
            @node-drag-stop="onNodeDragStop"
            @pane-click="dismissAll"
        >
            <template #node-module="{ data, id }">
                <ModuleNode
                    :data="data"
                    @dblclick="menu.settingsPanel = { moduleId: id }"
                    @longpress="(e: TouchEvent) => menu.openContextMenuFromTouch(id, e)"
                />
            </template>
            <template #node-xref="{ data, id }">
                <XrefNode
                    :id="id"
                    :data="data"
                    @open="xref.openTagMenu"
                    @settings="xref.openPanel"
                />
            </template>
        </VueFlow>

        <PageTabs
            :pages="pageTabs"
            :current-id="currentPage"
            @select="pages.selectPage"
            @add="pages.addPage"
            @rename="pages.renamePage"
            @move="pages.movePage"
            @delete="pages.deletePage"
        />

        <!-- Log drawer, panels, menus and confirms -->
        <RoutingOverlays
            ref="overlays"
            :engine-id="engineId"
            :ui="ui"
            :menu="menu"
            :multi="multi"
            :xref="xref"
            @add-module="onAddModule"
            @edge-delete="onEdgeDelete"
            @panel-select="pages.adoptModule"
        />
    </div>
</template>

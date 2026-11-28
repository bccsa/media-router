<script setup lang="ts">
/**
 * The routing editor's panel host: log drawer, add-module and settings panels,
 * interlocks, context menus, edge label and channel map editors, the
 * cross-reference tags' overlays (XrefOverlays), and the delete and reset confirms. Multi-root on purpose: the log drawer is an
 * in-flow child of the editor's flex column; everything else is fixed or
 * teleported.
 */
import type { UnwrapNestedRefs } from 'vue';
import ModuleSettingsPanel from './ModuleSettingsPanel.vue';
import AddModulePanel from './AddModulePanel.vue';
import LogViewer from './LogViewer.vue';
import ChannelMapEditor from './ChannelMapEditor.vue';
import EdgeLabelEditor from './EdgeLabelEditor.vue';
import InterlockPanel from './InterlockPanel.vue';
import XrefOverlays from './XrefOverlays.vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import { engineActions } from '@/utils/engineActions';
import type { useContextMenu } from '@/composables/useContextMenu';
import type { useMultiSelect } from '@/composables/useMultiSelect';
import type { XrefUi } from '@/composables/useXrefUi';

/** Editor panels the toolbar opens; the editor owns them as one `reactive`. */
export interface RoutingUi {
    showAddPanel: boolean;
    showModuleList: boolean;
    showLogs: boolean;
    showResetConfirm: boolean;
    showInterlocks: boolean;
}

const props = defineProps<{
    engineId: string;
    ui: RoutingUi;
    /** `reactive(useContextMenu(…))`: module and edge menus, settings panel, edge editors. */
    menu: UnwrapNestedRefs<ReturnType<typeof useContextMenu>>;
    /** `reactive(useMultiSelect(…))`: the delete confirm. */
    multi: UnwrapNestedRefs<ReturnType<typeof useMultiSelect>>;
    /** `reactive(useXrefUi(…))`: tag dropdown, tag panel, link picker, unlink confirm. */
    xref?: UnwrapNestedRefs<XrefUi>;
}>();

const emit = defineEmits<{
    addModule: [plugin: { pluginId: string }, displayName: string];
    edgeDelete: [edgeId: string];
    /** The settings panel moved to another module: only its Clone does, to the copy. */
    panelSelect: [moduleId: string];
}>();

/** True while a panel, menu or dialog is open — the canvas keys are left alone. */
function isBlocked(): boolean {
    const { menu, ui } = props;
    return !!(
        menu.contextMenu ||
        menu.edgeContextMenu ||
        menu.settingsPanel ||
        menu.editingEdgeLabel ||
        menu.channelMapEdge ||
        ui.showAddPanel ||
        ui.showInterlocks ||
        ui.showResetConfirm ||
        ui.showModuleList ||
        props.xref?.isOpen
    );
}
defineExpose({ isBlocked });

function onEdgeAction(action: string) {
    props.menu.onEdgeContextAction(action, (id) => emit('edgeDelete', id));
}

function onPanelSelect(moduleId: string) {
    props.menu.settingsPanel = { moduleId };
    emit('panelSelect', moduleId);
}

function confirmReset() {
    props.ui.showResetConfirm = false;
    void engineActions.reset(props.engineId);
}
</script>

<template>
    <!-- Log drawer -->
    <div v-if="ui.showLogs" class="shrink-0 border-t border-border bg-card" style="height: 250px">
        <div class="flex items-center justify-between px-3 py-1 border-b border-border-alt">
            <span class="text-[10px] font-semibold uppercase tracking-wider text-muted"
                >Engine Logs</span
            >
            <button @click="ui.showLogs = false" class="p-0.5 rounded text-muted">
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path d="M6 18L18 6M6 6l12 12" />
                </svg>
            </button>
        </div>
        <LogViewer :engine-id="engineId" style="height: calc(100% - 28px)" />
    </div>

    <AddModulePanel
        v-if="ui.showAddPanel"
        @close="ui.showAddPanel = false"
        @add="(plugin, name) => emit('addModule', plugin, name)"
    />

    <InterlockPanel
        v-if="ui.showInterlocks"
        :engine-id="engineId"
        @close="ui.showInterlocks = false"
    />

    <MrContextMenu
        v-if="menu.contextMenu"
        :items="menu.contextMenuItems"
        :x="menu.contextMenu.x"
        :y="menu.contextMenu.y"
        @action="menu.onContextAction"
        @slider-change="menu.onContextSliderChange"
        @toggle-change="menu.onContextToggleChange"
        @close="menu.contextMenu = null"
    />

    <MrContextMenu
        v-if="menu.edgeContextMenu"
        :items="menu.edgeMenuItems"
        :x="menu.edgeContextMenu.x"
        :y="menu.edgeContextMenu.y"
        @action="onEdgeAction"
        @close="menu.edgeContextMenu = null"
    />

    <!-- Edge label editor -->
    <EdgeLabelEditor
        v-if="menu.editingEdgeLabel"
        :label="menu.editingEdgeLabel.label"
        @save="
            (l: string) => {
                menu.editingEdgeLabel!.label = l;
                menu.saveEdgeLabel();
            }
        "
        @close="menu.editingEdgeLabel = null"
    />

    <ModuleSettingsPanel
        v-if="menu.settingsPanel"
        :engine-id="engineId"
        :module-id="menu.settingsPanel.moduleId"
        @select="onPanelSelect"
        @close="menu.settingsPanel = null"
    />

    <XrefOverlays v-if="xref" :xref="xref" />

    <!-- Channel Map Editor -->
    <ChannelMapEditor
        v-if="menu.channelMapEdge"
        :engine-id="engineId"
        :connection-id="menu.channelMapEdge"
        @close="menu.channelMapEdge = null"
    />

    <!-- Delete confirmation (group action / Delete key) -->
    <MrModal
        v-if="multi.pendingDelete"
        :title="multi.deleteTitle"
        @close="multi.pendingDelete = null"
    >
        <p class="text-sm text-subtle">{{ multi.deleteMessage }}</p>
        <template #footer>
            <MrButton size="sm" variant="secondary" @click="multi.pendingDelete = null"
                >Cancel</MrButton
            >
            <MrButton size="sm" variant="danger" @click="multi.confirmDelete">Delete</MrButton>
        </template>
    </MrModal>

    <!-- Reset confirmation -->
    <Teleport to="body">
        <div
            v-if="ui.showResetConfirm"
            class="fixed inset-0 z-50 flex items-center justify-center"
            style="background: rgba(0, 0, 0, 0.5)"
        >
            <div class="rounded-lg shadow-xl p-5 max-w-sm w-full mx-4 bg-card border border-border">
                <h3 class="text-base font-semibold mb-2 text-foreground">Reset Engine?</h3>
                <p class="text-sm mb-4 text-subtle">
                    This will stop all modules, restart PipeWire, and restart all modules. Audio
                    will be interrupted for a few seconds.
                </p>
                <div class="flex justify-end gap-2">
                    <MrButton size="sm" variant="secondary" @click="ui.showResetConfirm = false"
                        >Cancel</MrButton
                    >
                    <MrButton size="sm" variant="danger" @click="confirmReset">Reset</MrButton>
                </div>
            </div>
        </div>
    </Teleport>
</template>

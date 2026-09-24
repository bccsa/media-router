import { ref, computed, type ComputedRef } from 'vue';
import type { Node } from '@vue-flow/core';
import type { EngineState, ModuleState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { useSocketStore } from '@/stores/socket';
import { patch } from '@/composables/usePatch';
import {
    buildEdgeMenuItems,
    buildGroupMenuItems,
    buildModuleMenuItems,
} from '@/utils/moduleMenuItems';

/** Actions that stay as commands (lifecycle operations). */
const commandActions: Record<string, string> = {
    restart: 'module:restart',
};

/** Canvas multi-selection hooks; omitted = single-module menus only. */
export interface MenuSelection {
    selectedIds: () => string[];
    requestDelete: (moduleIds: string[]) => void;
}

const isModule = (m: ModuleState | undefined): m is ModuleState => !!m;

export function useContextMenu(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusedModules: ComputedRef<Set<string>>,
    selection?: MenuSelection,
) {
    const socket = useSocketStore();

    // `targets` = modules the menu acts on: one, or the whole selection.
    const contextMenu = ref<{ x: number; y: number; targets: string[] } | null>(null);
    const edgeContextMenu = ref<{ x: number; y: number; edgeId: string } | null>(null);
    const settingsPanel = ref<{ moduleId: string } | null>(null);
    let contextMenuOpenedAt = 0;

    /** First target — the module inline settings sliders act on. */
    const menuModuleId = computed(() => contextMenu.value?.targets[0] ?? '');

    const contextMenuItems = computed<MenuItem[]>(() => {
        const targets = contextMenu.value?.targets ?? [];
        const modules = engine.value?.modules ?? {};
        if (targets.length > 1) {
            const mods = targets.map((id) => modules[id]).filter(isModule);
            const allFocused = targets.every((id) => focusedModules.value.has(id));
            return buildGroupMenuItems(mods, allFocused);
        }
        const id = targets[0] ?? '';
        return buildModuleMenuItems(modules[id], focusedModules.value.has(id));
    });

    /** Selection to act on when `id` is clicked: the group if `id` is in it. */
    function targetsFor(id: string): string[] {
        const sel = selection?.selectedIds() ?? [];
        return sel.length > 1 && sel.includes(id) ? sel : [id];
    }

    function openAt(x: number, y: number, targets: string[]) {
        if (targets.length === 0) return;
        contextMenu.value = { x, y, targets };
        contextMenuOpenedAt = Date.now();
    }

    function onNodeContextMenu(payload: { event: MouseEvent | TouchEvent; node: Node }) {
        payload.event.preventDefault();
        const e = payload.event;
        const x = 'clientX' in e ? e.clientX : e.touches[0].clientX;
        const y = 'clientY' in e ? e.clientY : e.touches[0].clientY;
        openAt(x, y, targetsFor(payload.node.id));
    }

    /** Right-click on the dashed rectangle around a multi-selection. */
    function onSelectionContextMenu(payload: { event: MouseEvent; nodes: Node[] }) {
        payload.event.preventDefault();
        openAt(
            payload.event.clientX,
            payload.event.clientY,
            payload.nodes.map((n) => n.id),
        );
    }

    function openContextMenuFromTouch(id: string, e: TouchEvent) {
        const touch = e.touches[0] ?? e.changedTouches[0];
        if (touch) openAt(touch.clientX, touch.clientY, targetsFor(id));
    }

    function dismissContextMenus() {
        if (Date.now() - contextMenuOpenedAt < 300) return;
        contextMenu.value = null;
        edgeContextMenu.value = null;
    }

    function onContextAction(action: string) {
        if (!contextMenu.value) return;
        const ids = contextMenu.value.targets;
        const moduleId = ids[0];
        const eid = engineId();

        if (action === 'settings') {
            settingsPanel.value = { moduleId };
        } else if (action === 'clone') {
            // Open the copy so the user can edit it straight away (#675).
            const cloneId = patch.cloneModule(eid, moduleId);
            if (cloneId) settingsPanel.value = { moduleId: cloneId };
        } else if (action === 'enable' || action === 'disable') {
            patch.modulesField(eid, ids, 'enabled', action === 'enable');
        } else if (action === 'focus' || action === 'unfocus') {
            patch.modulesField(eid, ids, 'focused', action === 'focus');
        } else if (action === 'delete') {
            // A picked single Delete is explicit; a group delete confirms first.
            if (ids.length > 1 && selection) selection.requestDelete(ids);
            else patch.removeModules(eid, ids);
        } else if (commandActions[action]) {
            for (const id of ids) socket.emit(commandActions[action], { engineId: eid, moduleId: id });
        }
        contextMenu.value = null;
    }

    function eventPoint(e: any): { x: number; y: number } {
        return {
            x: 'clientX' in e ? e.clientX : (e.touches?.[0]?.clientX ?? 0),
            y: 'clientY' in e ? e.clientY : (e.touches?.[0]?.clientY ?? 0),
        };
    }

    function onEdgeClick(payload: any) {
        edgeContextMenu.value = { ...eventPoint(payload.event), edgeId: payload.edge.id };
        contextMenuOpenedAt = Date.now();
    }

    function onEdgeContextMenu(payload: any) {
        payload.event.preventDefault();
        edgeContextMenu.value = { ...eventPoint(payload.event), edgeId: payload.edge.id };
    }

    // --- Edge context menu items ---
    const editingEdgeLabel = ref<{ edgeId: string; label: string } | null>(null);
    const channelMapEdge = ref<string | null>(null);

    const edgeMenuItems = computed<MenuItem[]>(() => {
        const conn = edgeContextMenu.value
            ? engine.value?.connections.find((c) => c.id === edgeContextMenu.value!.edgeId)
            : null;
        const srcStreamType = conn
            ? engine.value?.modules[conn.sourceModuleId]?.ports?.find(
                  (p) => p.id === conn.sourcePortId,
              )?.streamType
            : undefined;
        // Channel maps apply to both audio transports: pw-links re-wire per
        // the map; 302m edges render it as an audioconvert mix-matrix in the
        // consumer's decode branch.
        return buildEdgeMenuItems(srcStreamType === 'audio/pcm' || srcStreamType === 'audio/302m');
    });

    function onEdgeContextAction(action: string, onDelete: (edgeId: string) => void) {
        if (!edgeContextMenu.value) return;
        const edgeId = edgeContextMenu.value.edgeId;

        switch (action) {
            case 'delete':
                onDelete(edgeId);
                break;
            case 'editLabel': {
                const conn = engine.value?.connections.find((c) => c.id === edgeId);
                editingEdgeLabel.value = { edgeId, label: conn?.label ?? '' };
                break;
            }
            case 'channelMap':
                channelMapEdge.value = edgeId;
                break;
        }
        edgeContextMenu.value = null;
    }

    function saveEdgeLabel() {
        if (!editingEdgeLabel.value) return;
        patch.connectionField(
            engineId(),
            editingEdgeLabel.value.edgeId,
            'label',
            editingEdgeLabel.value.label || '',
        );
        editingEdgeLabel.value = null;
    }

    return {
        contextMenu,
        menuModuleId,
        edgeContextMenu,
        settingsPanel,
        contextMenuItems,
        edgeMenuItems,
        editingEdgeLabel,
        channelMapEdge,
        onNodeContextMenu,
        onSelectionContextMenu,
        openContextMenuFromTouch,
        openGroupMenuAt: openAt,
        dismissContextMenus,
        onContextAction,
        onEdgeClick,
        onEdgeContextMenu,
        onEdgeContextAction,
        saveEdgeLabel,
    };
}

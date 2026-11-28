import { ref, computed, getCurrentInstance, onUnmounted, type ComputedRef } from 'vue';
import type { Node } from '@vue-flow/core';
import type { EngineState, ModuleState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { engineActions } from '@/utils/engineActions';
import { patch } from '@/composables/usePatch';
import { createLiveWrites } from '@/utils/liveWrites';
import { buildGroupMenuItems, buildModuleMenuItems } from '@/utils/moduleMenuItems';
import { useEdgeMenu, type EdgeMenuRefs } from '@/composables/useEdgeMenu';
import type { Pages } from '@/composables/usePages';
import { buildPageMoveItems, PAGE_ACTION } from '@/utils/pageMenuItems';
import { XREF_NODE_TYPE } from '@/utils/crossRefTypes';

/** Canvas multi-selection hooks; omitted = single-module menus only. */
export interface MenuSelection {
    selectedIds: () => string[];
    requestDelete: (moduleIds: string[]) => void;
}

/** The editor's pages (usePages); omitted = no "Move to" items, clones stay unassigned. */
export type MenuPages = Pick<
    Pages,
    'pages' | 'pageOf' | 'moveRefusal' | 'moveModules' | 'newModuleOps'
>;

const isModule = (m: ModuleState | undefined): m is ModuleState => !!m;

export function useContextMenu(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusedModules: ComputedRef<Set<string>>,
    selection?: MenuSelection,
    pages?: MenuPages,
    /** Cross-reference tags (ADR-0030): stub clicks and "Show as cross-reference". */
    refs?: EdgeMenuRefs,
) {
    // `targets` = modules the menu acts on: one, or the whole selection.
    const contextMenu = ref<{ x: number; y: number; targets: string[] } | null>(null);
    const settingsPanel = ref<{ moduleId: string } | null>(null);
    let contextMenuOpenedAt = 0;
    const edgeMenu = useEdgeMenu(engineId, engine, () => (contextMenuOpenedAt = Date.now()), refs);

    /** First target — the module inline settings sliders act on. */
    const menuModuleId = computed(() => contextMenu.value?.targets[0] ?? '');

    const pageItems = (ids: string[]): MenuItem[] =>
        pages && ids.length > 0
            ? buildPageMoveItems(ids, {
                  pages: pages.pages.value,
                  pageOf: pages.pageOf,
                  refusal: pages.moveRefusal,
              })
            : [];

    const contextMenuItems = computed<MenuItem[]>(() => {
        const targets = contextMenu.value?.targets ?? [];
        const modules = engine.value?.modules ?? {};
        if (targets.length > 1) {
            const mods = targets.map((id) => modules[id]).filter(isModule);
            const allFocused = targets.every((id) => focusedModules.value.has(id));
            return buildGroupMenuItems(mods, allFocused, pageItems(mods.map((m) => m.instanceId)));
        }
        const id = targets[0] ?? '';
        const mod = modules[id];
        return buildModuleMenuItems(mod, focusedModules.value.has(id), mod ? pageItems([id]) : []);
    });

    /** Selection to act on when `id` is clicked: the group if `id` is in it. */
    function targetsFor(id: string): string[] {
        const sel = selection?.selectedIds() ?? [];
        return sel.length > 1 && sel.includes(id) ? sel : [id];
    }

    function openAt(x: number, y: number, ids: string[]) {
        // Module menus act on modules only (cross-reference tags have their own).
        const targets = ids.filter((id) => !!engine.value?.modules[id]);
        if (targets.length === 0) return;
        contextMenu.value = { x, y, targets };
        contextMenuOpenedAt = Date.now();
    }

    function onNodeContextMenu(payload: { event: MouseEvent | TouchEvent; node: Node }) {
        payload.event.preventDefault();
        const e = payload.event;
        const x = 'clientX' in e ? e.clientX : e.touches[0].clientX;
        const y = 'clientY' in e ? e.clientY : e.touches[0].clientY;
        // A cross-reference tag's right-click opens the tag's own dropdown.
        if (payload.node.type === XREF_NODE_TYPE) refs?.openTagMenu(payload.node.id, x, y);
        else openAt(x, y, targetsFor(payload.node.id));
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
        edgeMenu.edgeContextMenu.value = null;
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
            if (cloneId) {
                // The copy lands on the page being shown.
                const ops = pages?.newModuleOps([cloneId]) ?? [];
                if (ops.length > 0) patch.editor(eid, ops);
                settingsPanel.value = { moduleId: cloneId };
            }
        } else if (action === 'enable' || action === 'disable') {
            patch.modulesField(eid, ids, 'enabled', action === 'enable');
        } else if (action === 'focus' || action === 'unfocus') {
            patch.modulesField(eid, ids, 'focused', action === 'focus');
        } else if (action === 'delete') {
            // A picked single Delete is explicit; a group delete confirms first.
            if (ids.length > 1 && selection) selection.requestDelete(ids);
            else patch.removeModules(eid, ids);
        } else if (action === 'restart') {
            for (const id of ids) void engineActions.restartModule(eid, id);
        } else if (action.startsWith(PAGE_ACTION)) {
            pages?.moveModules(ids, action.slice(PAGE_ACTION.length));
        }
        contextMenu.value = null;
    }

    // A menu slider writes as it moves, throttled; each held value goes to the module and key it was
    // made on, whichever menu is open by then (B-106).
    const sliderWrites = createLiveWrites(
        (t, value) => patch.moduleSetting(t.engineId, t.moduleId, t.key, value),
        100,
    );
    if (getCurrentInstance()) onUnmounted(() => sliderWrites.flush());

    /** The `x-contextMenu` setting an inline control's action names, or null. */
    const settingOf = (action: string) =>
        contextMenu.value && action.startsWith('setting:') ? action.slice('setting:'.length) : null;

    function onContextSliderChange(action: string, value: number) {
        const key = settingOf(action);
        if (!key) return;
        sliderWrites.throttle({ engineId: engineId(), moduleId: menuModuleId.value, key }, value);
    }

    function onContextToggleChange(action: string, value: boolean) {
        const key = settingOf(action);
        if (key) patch.moduleSetting(engineId(), menuModuleId.value, key, value);
    }

    return {
        contextMenu,
        menuModuleId,
        settingsPanel,
        contextMenuItems,
        onNodeContextMenu,
        onSelectionContextMenu,
        openContextMenuFromTouch,
        openGroupMenuAt: openAt,
        dismissContextMenus,
        onContextAction,
        onContextSliderChange,
        onContextToggleChange,
        // Edge menu: edgeContextMenu, edgeMenuItems, editingEdgeLabel, channelMapEdge,
        // onEdgeClick, onEdgeContextMenu, onEdgeContextAction, saveEdgeLabel.
        ...edgeMenu,
    };
}

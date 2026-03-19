import { ref, computed, type ComputedRef, type Ref } from 'vue';
import type { Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { useSocketStore } from '@/stores/socket';

// SVG icon paths (stroke-based, 24x24 viewBox)
const icons = {
    restart: '<polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    clone: '<rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
    disable: '<circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />',
    enable: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />',
    focus: '<circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />',
    delete: '<polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />',
};

/** Map context menu actions to Socket.IO events + extra payload */
const moduleActions: Record<string, { event: string; data?: Record<string, unknown> } | null> = {
    restart: { event: 'module:restart' },
    enable:  { event: 'module:toggle', data: { enabled: true } },
    disable: { event: 'module:toggle', data: { enabled: false } },
    delete:  { event: 'module:delete' },
    focus:   null,
    unfocus: null,
    settings: null,
    clone: null,
};

export function useContextMenu(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    focusedModules: ComputedRef<Set<string>>,
    setModuleFocused: (engineId: string, moduleId: string, focused: boolean) => void,
) {
    const socket = useSocketStore();

    const contextMenu = ref<{ x: number; y: number; moduleId: string } | null>(null);
    const edgeContextMenu = ref<{ x: number; y: number; edgeId: string } | null>(null);
    const settingsPanel = ref<{ moduleId: string } | null>(null);
    let contextMenuOpenedAt = 0;

    const contextMenuItems = computed<MenuItem[]>(() => {
        const mod = contextMenu.value ? engine.value?.modules[contextMenu.value.moduleId] : null;
        const isEnabled = mod?.enabled !== false;
        const moduleId = contextMenu.value?.moduleId ?? '';
        const isFocused = focusedModules.value.has(moduleId);

        return [
            { label: 'Restart', action: 'restart', icon: icons.restart },
            { label: 'Settings', action: 'settings', icon: icons.settings },
            { label: 'Clone', action: 'clone', icon: icons.clone },
            { label: '', action: '', divider: true },
            isEnabled
                ? { label: 'Disable', action: 'disable', icon: icons.disable }
                : { label: 'Enable', action: 'enable', icon: icons.enable },
            { label: '', action: '', divider: true },
            isFocused
                ? { label: 'Default', action: 'unfocus', icon: icons.focus }
                : { label: 'Focus', action: 'focus', icon: icons.focus },
            { label: '', action: '', divider: true },
            { label: 'Delete', action: 'delete', danger: true, icon: icons.delete },
        ];
    });

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
        if (Date.now() - contextMenuOpenedAt < 300) return;
        contextMenu.value = null;
        edgeContextMenu.value = null;
    }

    function onContextAction(action: string) {
        if (!contextMenu.value) return;
        const moduleId = contextMenu.value.moduleId;

        if (action === 'settings') {
            settingsPanel.value = { moduleId };
        } else if (action === 'focus' || action === 'unfocus') {
            setModuleFocused(engineId(), moduleId, action === 'focus');
        } else if (action === 'clone') {
            const mod = engine.value?.modules[moduleId];
            if (mod) {
                socket.emit('module:add', {
                    engineId: engineId(),
                    pluginId: mod.pluginId,
                    displayName: mod.displayName + ' (copy)',
                    position: { x: (mod.position?.x ?? 100) + 50, y: (mod.position?.y ?? 100) + 50 },
                    settings: { ...mod.settings },
                });
            }
        } else {
            const entry = moduleActions[action];
            if (entry) {
                socket.emit(entry.event, { engineId: engineId(), moduleId, ...entry.data });
            }
        }
        contextMenu.value = null;
    }

    function onEdgeClick(payload: any) {
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

    return {
        contextMenu,
        edgeContextMenu,
        settingsPanel,
        contextMenuItems,
        onNodeContextMenu,
        openContextMenuFromTouch,
        dismissContextMenus,
        onContextAction,
        onEdgeClick,
        onEdgeContextMenu,
    };
}

import { ref, computed } from 'vue';
import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import { useEngineStore } from '@/stores/engines';
import { useEngineGroupsStore } from '@/stores/engineGroups';
import { useSocketStore } from '@/stores/socket';
import { engineGroupsApi } from '@/api/engineGroups';

/**
 * Hosts the sidebar context-menu state (which row was right-clicked, where to
 * draw the menu, what items to show) and the dispatcher that turns menu
 * actions into store mutations + REST calls. Extracted from AppSidebar.vue so
 * the sidebar template only deals with layout.
 *
 * Two callbacks are needed from the host:
 *   - `requestRename(groupId)` — the host owns the group component refs and
 *     calls `.startRename()` to enter inline-edit mode.
 *   - `requestEdit(groupId)`   — opens the host's name+color modal.
 *   - `requestDelete({groupId, groupName})` — opens the host's confirmation
 *     modal (host knows how to render it).
 */
export function useEngineSidebarMenu(callbacks: {
    requestRename: (groupId: string) => void;
    requestEdit: (groupId: string) => void;
    requestDelete: (target: { groupId: string; groupName: string }) => void;
}) {
    const engineStore = useEngineStore();
    const groupsStore = useEngineGroupsStore();
    const socket = useSocketStore();

    type EngineMenuCtx = { kind: 'engine'; engineId: string };
    type GroupMenuCtx = { kind: 'group'; groupId: string };
    const menu = ref<
        | (EngineMenuCtx & { x: number; y: number })
        | (GroupMenuCtx & { x: number; y: number })
        | null
    >(null);

    function openEngineMenu(ev: MouseEvent, engineId: string) {
        menu.value = { kind: 'engine', engineId, x: ev.clientX, y: ev.clientY };
    }
    function openGroupMenu(ev: MouseEvent, groupId: string) {
        menu.value = { kind: 'group', groupId, x: ev.clientX, y: ev.clientY };
    }
    function closeMenu() {
        menu.value = null;
    }

    const items = computed<MenuItem[]>(() => {
        if (!menu.value) return [];

        if (menu.value.kind === 'engine') {
            const engine = engineStore.getEngine(menu.value.engineId);
            if (!engine) return [];
            const moveItems: MenuItem[] = groupsStore.groupList
                .filter((g) => g.id !== engine.groupId)
                .map((g) => ({ label: `Move to ${g.name}`, action: `move:${g.id}` }));
            return [
                {
                    label: engine.running ? 'Stop' : 'Start',
                    action: engine.running ? 'engine:stop' : 'engine:start',
                    disabled: !engine.online,
                },
                { label: 'Reset', action: 'engine:reset', disabled: !engine.online },
                { label: '', action: 'div', divider: true },
                ...moveItems,
                { label: '', action: 'div2', divider: true },
                { label: 'Configure…', action: 'engine:configure' },
            ];
        }

        const group = groupsStore.groups.get(menu.value.groupId);
        if (!group) return [];
        return [
            { label: 'Edit…', action: 'group:edit' },
            { label: 'Rename', action: 'group:rename' },
            { label: group.collapsed ? 'Expand' : 'Collapse', action: 'group:toggle' },
            { label: '', action: 'div', divider: true },
            {
                label: 'Delete group',
                action: 'group:delete',
                danger: true,
                disabled: group.isDefault,
                tooltip: group.isDefault ? 'The default group cannot be removed' : undefined,
            },
        ];
    });

    async function dispatch(
        action: string,
        helpers: {
            navigate: (path: string) => void;
            /** Replaces all sort_orders in `groupId` with the given engineIds in order. */
            packGroup: (groupId: string, engineIds: string[]) => Promise<void>;
        },
    ) {
        if (!menu.value) return;
        const ctx = menu.value;
        menu.value = null;

        if (ctx.kind === 'engine') {
            const engineId = ctx.engineId;
            if (action === 'engine:start' || action === 'engine:stop' || action === 'engine:reset') {
                socket.emit(action, { engineId });
            } else if (action.startsWith('move:')) {
                const targetGroupId = action.slice('move:'.length);
                // Snapshot source group BEFORE any await — the first packGroup
                // call mutates engine.groupId via applyReorder. If we read it
                // after, sourceGroupId === targetGroupId and the real source's
                // sort_order gaps never close.
                const sourceGroupId = engineStore.getEngine(engineId)?.groupId;
                const target = engineStore.enginesByGroup.get(targetGroupId) ?? [];
                const targetIds = [...target.map((e) => e.engineId), engineId];
                await helpers.packGroup(targetGroupId, targetIds);
                if (sourceGroupId && sourceGroupId !== targetGroupId) {
                    const sourceIds = (engineStore.enginesByGroup.get(sourceGroupId) ?? [])
                        .filter((e) => e.engineId !== engineId)
                        .map((e) => e.engineId);
                    await helpers.packGroup(sourceGroupId, sourceIds);
                }
            } else if (action === 'engine:configure') {
                helpers.navigate('/engines');
            }
        } else {
            const groupId = ctx.groupId;
            if (action === 'group:rename') {
                callbacks.requestRename(groupId);
            } else if (action === 'group:edit') {
                callbacks.requestEdit(groupId);
            } else if (action === 'group:toggle') {
                const g = groupsStore.groups.get(groupId);
                if (g) await engineGroupsApi.update(groupId, { collapsed: !g.collapsed });
            } else if (action === 'group:delete') {
                const g = groupsStore.groups.get(groupId);
                if (g) callbacks.requestDelete({ groupId, groupName: g.name });
            }
        }
    }

    return { menu, items, openEngineMenu, openGroupMenu, closeMenu, dispatch };
}

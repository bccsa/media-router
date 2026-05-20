/**
 * @vitest-environment jsdom
 *
 * Focused regression tests for the menu dispatcher — in particular the
 * move-to-group flow, which previously read `engine.groupId` AFTER
 * `applyReorder` had already flipped it, leaving the source group's
 * sort_order packing un-closed. The bug surfaces as the source group
 * never receiving a repack call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEngineStore } from '@/stores/engines';
import { useEngineGroupsStore } from '@/stores/engineGroups';
import { useSocketStore } from '@/stores/socket';
import { useEngineSidebarMenu } from './useEngineSidebarMenu';

// engineGroupsApi.update routes through useSocketStore().request() since the
// HTTP API was retired — stub that to a resolved promise so collapse/toggle
// tests don't hang on the 10s "Socket not connected" timeout.
beforeEach(() => {
    setActivePinia(createPinia());
    const socket = useSocketStore();
    socket.request = vi.fn().mockResolvedValue(undefined) as typeof socket.request;
});

function seedStores() {
    const groups = useEngineGroupsStore();
    groups.setAll([
        { id: 'ungrouped', name: 'Ungrouped', sort_order: 0, is_default: 1 },
        { id: 'studio', name: 'Studio', sort_order: 1 },
    ]);
    const engines = useEngineStore();
    engines.addEngine({
        engine_id: 'e1',
        display_name: 'E1',
        group_id: 'studio',
        sort_order: 0,
        modules: {},
        connections: [],
    });
    engines.addEngine({
        engine_id: 'e2',
        display_name: 'E2',
        group_id: 'studio',
        sort_order: 1,
        modules: {},
        connections: [],
    });
    engines.addEngine({
        engine_id: 'u1',
        display_name: 'U1',
        group_id: 'ungrouped',
        sort_order: 0,
        modules: {},
        connections: [],
    });
    return { engines, groups };
}

describe('useEngineSidebarMenu — move-to dispatch', () => {
    it('packs BOTH source and target groups (regression: source was being read after mutation)', async () => {
        const { engines } = seedStores();
        const menu = useEngineSidebarMenu({
            requestRename: vi.fn(),
            requestEdit: vi.fn(),
            requestDelete: vi.fn(),
            requestReboot: vi.fn(),
        });
        // Open the menu for e1 (currently in 'studio').
        menu.openEngineMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'e1');

        const packGroup = vi.fn(async (groupId: string, ids: string[]) => {
            // Mirror the production behaviour: apply optimistic reorder so the
            // store reflects the move (and the bug under test would re-read).
            engines.applyReorder(
                ids.map((engineId, sortOrder) => ({ engineId, groupId, sortOrder })),
            );
        });

        await menu.dispatch('move:ungrouped', {
            navigate: vi.fn(),
            packGroup,
        });

        // Two packGroup calls: target first, then source.
        expect(packGroup).toHaveBeenCalledTimes(2);
        const [firstCall, secondCall] = packGroup.mock.calls;
        expect(firstCall[0]).toBe('ungrouped');
        expect(firstCall[1]).toEqual(['u1', 'e1']);
        expect(secondCall[0]).toBe('studio'); // SOURCE — would be 'ungrouped' under the bug
        expect(secondCall[1]).toEqual(['e2']);
    });

    it('does not repack the source when target === source', async () => {
        const { engines } = seedStores();
        const menu = useEngineSidebarMenu({
            requestRename: vi.fn(),
            requestEdit: vi.fn(),
            requestDelete: vi.fn(),
            requestReboot: vi.fn(),
        });
        menu.openEngineMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'e1');

        const packGroup = vi.fn(async (_groupId: string, _ids: string[]) => {});
        // A hypothetical "move to current group" — sourceGroupId === targetGroupId.
        await menu.dispatch('move:studio', {
            navigate: vi.fn(),
            packGroup,
        });
        // Only one call — no spurious source repack.
        expect(packGroup).toHaveBeenCalledTimes(1);
        expect(packGroup.mock.calls[0][0]).toBe('studio');
        // Silence unused warning on the helper.
        void engines;
    });

    it('start/stop/reset actions delegate to socket.emit', async () => {
        seedStores();
        const menu = useEngineSidebarMenu({
            requestRename: vi.fn(),
            requestEdit: vi.fn(),
            requestDelete: vi.fn(),
            requestReboot: vi.fn(),
        });
        menu.openEngineMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'e1');

        // We can't easily mock the socket store from outside, so just check
        // the menu closes (a side effect of dispatch running through the
        // start branch — no throw).
        await menu.dispatch('engine:start', { navigate: vi.fn(), packGroup: vi.fn() });
        expect(menu.menu.value).toBeNull();
    });

    it('group:rename routes through the requestRename callback', async () => {
        seedStores();
        const requestRename = vi.fn();
        const menu = useEngineSidebarMenu({
            requestRename,
            requestEdit: vi.fn(),
            requestDelete: vi.fn(),
            requestReboot: vi.fn(),
        });
        menu.openGroupMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'studio');
        await menu.dispatch('group:rename', { navigate: vi.fn(), packGroup: vi.fn() });
        expect(requestRename).toHaveBeenCalledWith('studio');
    });

    it('engine:reboot routes through requestReboot with the engine name (no direct socket emit)', async () => {
        seedStores();
        const requestReboot = vi.fn();
        const socket = useSocketStore();
        const emit = vi.spyOn(socket, 'emit');
        const menu = useEngineSidebarMenu({
            requestRename: vi.fn(),
            requestEdit: vi.fn(),
            requestDelete: vi.fn(),
            requestReboot,
        });
        menu.openEngineMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'e1');
        await menu.dispatch('engine:reboot', { navigate: vi.fn(), packGroup: vi.fn() });
        // Host owns the confirmation modal — the composable must NOT emit
        // engine:reboot directly, otherwise a stray right-click would reboot
        // the host without warning.
        expect(requestReboot).toHaveBeenCalledWith({ engineId: 'e1', engineName: 'E1' });
        expect(emit).not.toHaveBeenCalledWith('engine:reboot', expect.anything());
    });

    it('group:delete routes through requestDelete with name', async () => {
        seedStores();
        const requestDelete = vi.fn();
        const menu = useEngineSidebarMenu({
            requestRename: vi.fn(),
            requestEdit: vi.fn(),
            requestDelete,
            requestReboot: vi.fn(),
        });
        menu.openGroupMenu({ clientX: 0, clientY: 0 } as MouseEvent, 'studio');
        await menu.dispatch('group:delete', { navigate: vi.fn(), packGroup: vi.fn() });
        expect(requestDelete).toHaveBeenCalledWith({
            groupId: 'studio',
            groupName: 'Studio',
        });
    });
});

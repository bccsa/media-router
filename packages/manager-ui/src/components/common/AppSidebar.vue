<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import draggable from 'vuedraggable';
import { useEngineStore } from '@/stores/engines';
import { useEngineGroupsStore } from '@/stores/engineGroups';
import { useSocketStore } from '@/stores/socket';
import { engineGroupsApi } from '@/api/engineGroups';
import { useEngineSidebarMenu } from '@/composables/useEngineSidebarMenu';
import EngineGroup from './EngineGroup.vue';
import MrContextMenu from './MrContextMenu.vue';
import MrModal from './MrModal.vue';
import MrInput from './MrInput.vue';
import MrButton from './MrButton.vue';
import GroupColorPicker from './GroupColorPicker.vue';

const route = useRoute();
const router = useRouter();
const engineStore = useEngineStore();
const groupsStore = useEngineGroupsStore();
const socket = useSocketStore();

const open = ref(false);
watch(() => route.path, () => (open.value = false));

// --- Group ordering: local mirror that vuedraggable mutates. ---
const localGroups = ref([...groupsStore.groupList]);
watch(
    () => groupsStore.groupList,
    (next) => (localGroups.value = [...next]),
);

async function onGroupsReorder() {
    await engineGroupsApi.reorderGroups(localGroups.value.map((g) => g.id));
}

// --- Engine ordering ---
async function packGroup(groupId: string, engineIds: string[]) {
    const updates = engineIds.map((engineId, sortOrder) => ({
        engineId,
        groupId,
        sortOrder,
    }));
    // Optimistic local update so the UI doesn't snap back while the socket
    // broadcast round-trips. Server will re-confirm.
    engineStore.applyReorder(updates);
    await engineGroupsApi.reorderEngines(updates);
}

async function onEnginesChange(groupId: string, engineIds: string[]) {
    await packGroup(groupId, engineIds);
}

// --- Rename routing: composable raises a target; we forward to the group ref. ---
const groupRefs = ref<Record<string, InstanceType<typeof EngineGroup> | null>>({});
const renameTarget = ref<string | null>(null);
watch(renameTarget, (id) => {
    if (!id) return;
    groupRefs.value[id]?.startRename();
    renameTarget.value = null;
});

// --- Modals (new group / edit group / delete confirm) ---
const newGroupModal = ref(false);
const newGroupName = ref('');
const newGroupColor = ref<string | null>(null);
const newGroupInput = ref<InstanceType<typeof MrInput> | null>(null);

function openNewGroupModal() {
    newGroupName.value = '';
    newGroupColor.value = null;
    newGroupModal.value = true;
    nextTick(() => {
        const el = (newGroupInput.value as unknown as { $el?: HTMLElement })?.$el;
        el?.querySelector('input')?.focus();
    });
}
async function submitNewGroup() {
    const name = newGroupName.value.trim();
    if (!name) return;
    newGroupModal.value = false;
    await engineGroupsApi.create(name, newGroupColor.value);
}

const editModal = ref<{ groupId: string; name: string; color: string | null } | null>(null);
function openEditModal(groupId: string) {
    const g = groupsStore.groups.get(groupId);
    if (!g) return;
    editModal.value = { groupId, name: g.name, color: g.color ?? null };
}
async function submitEdit() {
    if (!editModal.value) return;
    const { groupId, name, color } = editModal.value;
    editModal.value = null;
    await engineGroupsApi.update(groupId, { name: name.trim(), color });
}

const deleteModal = ref<{ groupId: string; groupName: string } | null>(null);
async function confirmDeleteGroup() {
    if (!deleteModal.value) return;
    const id = deleteModal.value.groupId;
    deleteModal.value = null;
    await engineGroupsApi.remove(id);
}

const rebootModal = ref<{ engineId: string; engineName: string } | null>(null);
function confirmRebootEngine() {
    if (!rebootModal.value) return;
    const engineId = rebootModal.value.engineId;
    rebootModal.value = null;
    socket.emit('engine:reboot', { engineId });
}

// Failure notification driven by the engine reporting `rebootFailed`
// (e.g. polkit denied). The socket store holds the shared ref so this
// works even if the sidebar is unmounted mid-flight on a route change.
const rebootFailureModal = ref<{ engineName: string; reason: string } | null>(null);
watch(
    () => socket.rebootFailure,
    (next) => {
        if (!next) return;
        const engine = engineStore.getEngine(next.engineId);
        rebootFailureModal.value = {
            engineName: engine?.name || next.engineId,
            reason: next.reason,
        };
    },
);
function dismissRebootFailure() {
    rebootFailureModal.value = null;
    socket.clearRebootFailure();
}

// --- Context menu (delegated to composable) ---
const {
    menu: contextMenu,
    items: contextMenuItems,
    openEngineMenu,
    openGroupMenu,
    closeMenu,
    dispatch: dispatchMenuAction,
} = useEngineSidebarMenu({
    requestRename: (id) => (renameTarget.value = id),
    requestEdit: openEditModal,
    requestDelete: (target) => (deleteModal.value = target),
    requestReboot: (target) => (rebootModal.value = target),
});

function onMenuAction(action: string) {
    dispatchMenuAction(action, { navigate: (p) => router.push(p), packGroup });
}

// --- Misc helpers ---
function enginesFor(groupId: string) {
    return engineStore.enginesByGroup.get(groupId) ?? [];
}
async function onGroupRename(groupId: string, name: string) {
    await engineGroupsApi.update(groupId, { name });
}
async function onGroupCollapsedChange(groupId: string, collapsed: boolean) {
    await engineGroupsApi.update(groupId, { collapsed });
}

const totalEngines = computed(() => engineStore.engineList.length);
</script>

<template>
    <!-- Mobile hamburger -->
    <button
        class="fixed top-2 left-2 z-50 p-2 rounded-md md:hidden bg-card border border-border text-foreground"
        @click="open = !open"
    >
        <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
        >
            <template v-if="!open">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
            </template>
            <template v-else>
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
            </template>
        </svg>
    </button>

    <div v-if="open" class="fixed inset-0 z-30 bg-black/50 md:hidden" @click="open = false" />

    <aside
        class="shrink-0 flex flex-col h-full overflow-y-auto transition-transform duration-200 w-[220px] fixed z-40 md:relative md:translate-x-0 bg-sidebar border-r border-border"
        :class="open ? 'translate-x-0' : '-translate-x-full'"
    >
        <nav class="flex-1 py-3 px-2 space-y-4">
            <div>
                <RouterLink
                    to="/engines"
                    class="flex items-center justify-between px-3 py-1 mb-1 text-muted"
                >
                    <span class="text-[10px] font-semibold uppercase tracking-wider">Engines</span>
                    <span class="text-[10px]">{{ totalEngines }}</span>
                </RouterLink>

                <draggable
                    v-model="localGroups"
                    item-key="id"
                    handle=".group-header"
                    class="space-y-2"
                    ghost-class="opacity-40"
                    @end="onGroupsReorder"
                >
                    <template #item="{ element: group }">
                        <EngineGroup
                            :ref="(el) => (groupRefs[group.id] = el as InstanceType<typeof EngineGroup>)"
                            :group="group"
                            :engines="enginesFor(group.id)"
                            @engines-change="onEnginesChange"
                            @engine-contextmenu="openEngineMenu"
                            @group-contextmenu="openGroupMenu"
                            @rename="onGroupRename"
                            @toggle-collapsed="onGroupCollapsedChange"
                        />
                    </template>
                </draggable>

                <button
                    class="w-full mt-2 px-3 py-1 text-[10px] text-muted hover:text-foreground border border-dashed border-border rounded-md"
                    @click="openNewGroupModal"
                >
                    + New group
                </button>

                <div v-if="totalEngines === 0" class="px-3 py-1.5 text-xs text-muted">
                    No engines
                </div>
            </div>

            <div>
                <div class="px-3 py-1 mb-1">
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted">
                        System
                    </span>
                </div>
                <RouterLink
                    to="/settings"
                    class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors"
                    :class="
                        route.path === '/settings'
                            ? 'text-accent-fg bg-accent-muted'
                            : 'text-subtle'
                    "
                >
                    Settings
                </RouterLink>
            </div>
        </nav>
        <div class="px-4 py-3 text-[10px] text-muted border-t border-border">Media Router v2.0</div>

        <MrContextMenu
            v-if="contextMenu"
            :items="contextMenuItems"
            :x="contextMenu.x"
            :y="contextMenu.y"
            @action="onMenuAction"
            @close="closeMenu"
        />
    </aside>

    <MrModal v-if="newGroupModal" title="New group" @close="newGroupModal = false">
        <form class="space-y-3" @submit.prevent="submitNewGroup">
            <MrInput
                ref="newGroupInput"
                v-model="newGroupName"
                label="Group name"
                placeholder="e.g. Studio, On-Air"
            />
            <div>
                <label class="block text-xs font-medium text-foreground mb-1.5">Color</label>
                <GroupColorPicker v-model="newGroupColor" />
            </div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="newGroupModal = false">Cancel</MrButton>
            <MrButton :disabled="!newGroupName.trim()" @click="submitNewGroup">Create</MrButton>
        </template>
    </MrModal>

    <MrModal v-if="editModal" title="Edit group" @close="editModal = null">
        <form class="space-y-3" @submit.prevent="submitEdit">
            <MrInput v-model="editModal.name" label="Group name" />
            <div>
                <label class="block text-xs font-medium text-foreground mb-1.5">Color</label>
                <GroupColorPicker v-model="editModal.color" />
            </div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="editModal = null">Cancel</MrButton>
            <MrButton :disabled="!editModal.name.trim()" @click="submitEdit">Save</MrButton>
        </template>
    </MrModal>

    <MrModal
        v-if="deleteModal"
        :title="`Delete group ${deleteModal.groupName}?`"
        @close="deleteModal = null"
    >
        <p class="text-sm text-muted">
            Engines in this group will be moved to <strong>Ungrouped</strong>.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="deleteModal = null">Cancel</MrButton>
            <MrButton variant="danger" @click="confirmDeleteGroup">Delete</MrButton>
        </template>
    </MrModal>

    <MrModal
        v-if="rebootModal"
        :title="`Reboot ${rebootModal.engineName}?`"
        @close="rebootModal = null"
    >
        <p class="text-sm text-muted">
            The engine host will run <code>systemctl reboot</code>. All routing on this engine
            stops until the box comes back up — usually under a minute.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="rebootModal = null">Cancel</MrButton>
            <MrButton variant="danger" @click="confirmRebootEngine">Reboot</MrButton>
        </template>
    </MrModal>

    <MrModal
        v-if="rebootFailureModal"
        :title="`Reboot of ${rebootFailureModal.engineName} failed`"
        @close="dismissRebootFailure"
    >
        <p class="text-sm text-muted">
            The engine could not invoke <code>systemctl reboot</code>:
        </p>
        <pre class="mt-2 px-3 py-2 rounded-md bg-bg-primary text-xs whitespace-pre-wrap text-foreground">{{ rebootFailureModal.reason }}</pre>
        <p class="text-xs text-muted mt-2">
            Most likely the engine user lacks polkit permission for
            <code>org.freedesktop.login1.reboot</code>.
        </p>
        <template #footer>
            <MrButton @click="dismissRebootFailure">Close</MrButton>
        </template>
    </MrModal>
</template>

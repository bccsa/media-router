<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';

const props = defineProps<{ engineId: string }>();
const router = useRouter();
const engineStore = useEngineStore();
const socket = useSocketStore();
const engine = computed(() => engineStore.getEngine(props.engineId));

const showDelete = ref(false);
const deleting = ref(false);

const showEdit = ref(false);
const editForm = ref({ displayName: '', password: '' });
const editLoading = ref(false);
const editError = ref('');
const showPassword = ref(false);

function openEdit() {
    // Password stays blank: the server never round-trips the dgram-comms
    // shared secret to the client. Empty `password` on PUT means "keep
    // current" (httpRoutes UpdateEngineSchema treats it as optional).
    editError.value = '';
    showPassword.value = false;
    editForm.value = { displayName: engine.value?.name ?? '', password: '' };
    showEdit.value = true;
}

async function saveEdit() {
    if (!editForm.value.displayName) {
        editError.value = 'Display name is required';
        return;
    }
    editLoading.value = true;
    editError.value = '';
    try {
        const body: { displayName: string; password?: string } = {
            displayName: editForm.value.displayName,
        };
        if (editForm.value.password) body.password = editForm.value.password;
        const res = await fetch(`/api/v1/engines/${props.engineId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            editError.value = data.error ?? 'Failed to update';
            return;
        }
        showEdit.value = false;
    } catch {
        editError.value = 'Network error';
    } finally {
        editLoading.value = false;
    }
}

async function deleteEngine() {
    deleting.value = true;
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}`, { method: 'DELETE' });
        if (res.ok) router.push('/engines');
    } catch {
        /* network error */
    }
    deleting.value = false;
    showDelete.value = false;
}

const infoRows = computed(() => {
    if (!engine.value) return [];
    const rows = [
        { label: 'Engine ID', value: engine.value.engineId },
        {
            label: 'Status',
            value: engine.value.online ? 'Online' : 'Offline',
            accent: engine.value.online,
        },
        {
            label: 'IP Address',
            value: engine.value.ips?.length
                ? engine.value.ips.join(', ')
                : engine.value.online
                  ? 'Detecting...'
                  : 'Unknown',
        },
        { label: 'Hostname', value: engine.value.hostname ?? '—' },
        ...(engine.value.buildNumber ? [{ label: 'Build', value: engine.value.buildNumber }] : []),
        { label: 'Active Profile', value: engine.value.activeProfile ?? 'None' },
        { label: 'Modules', value: String(Object.keys(engine.value.modules).length) },
        { label: 'Connections', value: String(engine.value.connections.length) },
    ];
    return rows;
});
</script>

<template>
    <div class="p-6 max-w-3xl">
        <div v-if="!engine" class="text-center py-16 text-muted">Engine not found.</div>
        <template v-else>
            <div class="flex items-center justify-between mb-5">
                <div class="flex items-center gap-3">
                    <h2 class="text-xl font-semibold text-foreground">{{ engine.name }}</h2>
                    <div
                        class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs"
                        :class="engine.online ? 'text-ok' : 'text-stopped'"
                        :style="{
                            backgroundColor: engine.online
                                ? 'rgba(34,197,94,0.1)'
                                : 'rgba(107,114,128,0.1)',
                        }"
                    >
                        <div
                            class="w-2 h-2 rounded-full"
                            :class="engine.online ? 'bg-ok' : 'bg-stopped'"
                        />
                        {{ engine.online ? 'Online' : 'Offline' }}
                    </div>
                </div>
                <div class="flex gap-2">
                    <MrButton size="sm" variant="secondary" @click="openEdit">Edit</MrButton>
                    <MrButton size="sm" variant="danger" @click="showDelete = true"
                        >Delete</MrButton
                    >
                </div>
            </div>

            <div class="rounded-lg overflow-hidden bg-card border border-border">
                <div
                    v-for="(row, i) in infoRows"
                    :key="row.label"
                    class="px-5 py-3.5 flex justify-between"
                    :class="i > 0 ? 'border-t border-border-alt' : ''"
                >
                    <span class="text-sm text-muted">{{ row.label }}</span>
                    <span
                        class="text-sm"
                        :class="row.accent ? 'text-accent-fg' : 'text-foreground'"
                        >{{ row.value }}</span
                    >
                </div>
            </div>

            <div class="mt-5 flex gap-4">
                <RouterLink
                    :to="`/routing/${engine.engineId}`"
                    class="text-sm hover:underline text-accent-fg"
                >
                    Open Routing Editor
                </RouterLink>
                <RouterLink
                    :to="`/profiles/${engine.engineId}`"
                    class="text-sm hover:underline text-accent-fg"
                >
                    Manage Profiles
                </RouterLink>
            </div>
        </template>
    </div>

    <MrModal v-if="showEdit" title="Edit Engine" @close="showEdit = false">
        <form @submit.prevent="saveEdit" class="space-y-3">
            <MrInput v-model="editForm.displayName" label="Display Name" type="text" />
            <div>
                <div class="flex items-center justify-between mb-1">
                    <label class="block text-xs font-medium text-foreground">Password</label>
                    <button
                        type="button"
                        class="text-[11px] text-accent-fg hover:underline"
                        @click="showPassword = !showPassword"
                    >
                        {{ showPassword ? 'Hide' : 'Show' }}
                    </button>
                </div>
                <MrInput
                    v-model="editForm.password"
                    :type="showPassword ? 'text' : 'password'"
                    placeholder="Leave blank to keep current"
                />
            </div>
            <div v-if="editError" class="text-sm text-red-400">{{ editError }}</div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="showEdit = false">Cancel</MrButton>
            <MrButton :loading="editLoading" @click="saveEdit">Save</MrButton>
        </template>
    </MrModal>

    <MrModal v-if="showDelete" title="Delete Engine" @close="showDelete = false">
        <p class="text-sm text-subtle">
            Are you sure you want to delete
            <strong class="text-foreground">{{ engine?.name }}</strong
            >? This cannot be undone.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="showDelete = false">Cancel</MrButton>
            <MrButton variant="danger" @click="deleteEngine" :disabled="deleting">{{
                deleting ? 'Deleting...' : 'Delete'
            }}</MrButton>
        </template>
    </MrModal>
</template>

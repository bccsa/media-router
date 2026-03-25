<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';

const props = defineProps<{ engineId: string }>();
const router = useRouter();
const engineStore = useEngineStore();
const socket = useSocketStore();
const engine = computed(() => engineStore.getEngine(props.engineId));

const showDelete = ref(false);
const deleting = ref(false);

async function deleteEngine() {
    deleting.value = true;
    try {
        const res = await fetch(`/api/v1/engines/${props.engineId}`, { method: 'DELETE' });
        if (res.ok) router.push('/engines');
    } catch { /* network error */ }
    deleting.value = false;
    showDelete.value = false;
}

const infoRows = computed(() => {
    if (!engine.value) return [];
    const rows = [
        { label: 'Engine ID', value: engine.value.engineId },
        { label: 'Status', value: engine.value.online ? 'Online' : 'Offline', accent: engine.value.online },
        { label: 'IP Address', value: engine.value.ip ?? (engine.value.online ? 'Detecting...' : 'Unknown') },
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
        <div v-if="!engine" class="text-center py-16" :style="{ color: 'var(--text-muted)' }">Engine not found.</div>
        <template v-else>
            <div class="flex items-center justify-between mb-5">
                <div class="flex items-center gap-3">
                    <h2 class="text-xl font-semibold" :style="{ color: 'var(--text-primary)' }">{{ engine.name }}</h2>
                    <div class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs"
                         :style="{ backgroundColor: engine.online ? 'rgba(34,197,94,0.1)' : 'rgba(107,114,128,0.1)', color: engine.online ? 'var(--health-ok)' : 'var(--health-stopped)' }">
                        <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: engine.online ? 'var(--health-ok)' : 'var(--health-stopped)' }" />
                        {{ engine.online ? 'Online' : 'Offline' }}
                    </div>
                </div>
                <MrButton size="sm" variant="danger" @click="showDelete = true">Delete</MrButton>
            </div>

            <div class="rounded-lg overflow-hidden" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
                <div v-for="(row, i) in infoRows" :key="row.label" class="px-5 py-3.5 flex justify-between"
                     :style="i > 0 ? { borderTop: '1px solid var(--border-secondary)' } : {}">
                    <span class="text-sm" :style="{ color: 'var(--text-muted)' }">{{ row.label }}</span>
                    <span class="text-sm" :style="{ color: row.accent ? 'var(--accent-text)' : 'var(--text-primary)' }">{{ row.value }}</span>
                </div>
            </div>

            <div class="mt-5 flex gap-4">
                <RouterLink :to="`/routing/${engine.engineId}`" class="text-sm hover:underline" :style="{ color: 'var(--accent-text)' }">
                    Open Routing Editor
                </RouterLink>
                <RouterLink :to="`/profiles/${engine.engineId}`" class="text-sm hover:underline" :style="{ color: 'var(--accent-text)' }">
                    Manage Profiles
                </RouterLink>
            </div>
        </template>
    </div>

    <MrModal v-if="showDelete" title="Delete Engine" @close="showDelete = false">
        <p class="text-sm" :style="{ color: 'var(--text-secondary)' }">
            Are you sure you want to delete <strong :style="{ color: 'var(--text-primary)' }">{{ engine?.name }}</strong>? This cannot be undone.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="showDelete = false">Cancel</MrButton>
            <MrButton variant="danger" @click="deleteEngine" :disabled="deleting">{{ deleting ? 'Deleting...' : 'Delete' }}</MrButton>
        </template>
    </MrModal>
</template>

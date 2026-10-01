<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { Dashboard } from '@media-router/shared-types';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';
import CopyDashboardDialog from '@/dashboard/manage/CopyDashboardDialog.vue';
import { managerSource } from '@/dashboard/managerSource';
import { useSubscription } from '@/dashboard/useValue';
import { useToast } from '@/composables/useToast';

/** A router's dashboards (ADR-0026): those of its active profile. */
const props = defineProps<{ engineId: string }>();
const router = useRouter();
const toast = useToast();
const source = managerSource();
const at = computed(() => `/engines/${props.engineId}`);
useSubscription(source, () => [`${at.value}/dashboards`, `${at.value}/info`]);

const info = computed(() => source.get<Record<string, any>>(`${at.value}/info`) ?? {});
const upgraded = computed(() => Array.isArray(info.value.features) && info.value.features.includes('dashboards'));
const dashboards = computed(() =>
    Object.entries(source.get<Record<string, Dashboard>>(`${at.value}/dashboards`) ?? {})
        .map(([id, d]) => ({ id, d }))
        .sort((a, b) => a.d.name.localeCompare(b.d.name)),
);

const creating = ref(false);
const newName = ref('');
const error = ref('');
const copying = ref<{ id: string; d: Dashboard } | null>(null);
const deleting = ref<{ id: string; d: Dashboard } | null>(null);

async function create() {
    error.value = '';
    try {
        const { id } = await source.call<{ id: string }>(`${at.value}/dashboards`, 'save', { dashboard: shared.newDashboard(newName.value.trim()) });
        creating.value = false;
        router.push({ path: `${at.value}/dashboards/${id}`, query: { edit: '1' } });
    } catch (err) {
        error.value = err instanceof Error ? err.message : 'Could not create it';
    }
}

async function remove() {
    const target = deleting.value;
    deleting.value = null;
    if (!target) return;
    try {
        await source.call(`${at.value}/dashboards/${target.id}`, 'delete', {});
    } catch (err) {
        toast.show(err instanceof Error ? err.message : 'Delete failed');
    }
}
</script>

<template>
    <div class="p-6 max-w-3xl">
        <div class="flex items-center justify-between mb-4">
            <div>
                <h2 class="text-xl font-semibold text-foreground">Dashboards</h2>
                <div class="text-sm text-muted">
                    {{ info.name ?? engineId }} · profile {{ info.activeProfile ?? '—' }}
                </div>
            </div>
            <MrButton size="sm" @click="creating = true; newName = ''; error = ''">New dashboard</MrButton>
        </div>

        <div v-if="info.online && !upgraded" class="mb-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
            This router runs an older engine: its dashboards work here in the manager, and appear on the router's own screen after its upgrade.
        </div>

        <div class="rounded-lg overflow-hidden bg-card border border-border">
            <div v-for="({ id, d }, i) in dashboards" :key="id" class="px-5 py-3 flex items-center gap-3" :class="i > 0 ? 'border-t border-border-alt' : ''">
                <RouterLink :to="`${at}/dashboards/${id}`" class="flex-1 min-w-0">
                    <div class="text-sm text-foreground truncate">{{ d.name }}</div>
                    <div class="text-xs text-muted">
                        {{ d.widgets.length }} widgets · {{ d.cols }} × {{ d.rows }}{{ d.locked ? ' · locked' : '' }} · {{ d.theme }}
                    </div>
                </RouterLink>
                <MrButton size="sm" variant="secondary" @click="router.push({ path: `${at}/dashboards/${id}`, query: { edit: '1' } })">Edit</MrButton>
                <MrButton size="sm" variant="secondary" @click="copying = { id, d }">Copy to…</MrButton>
                <MrButton size="sm" variant="danger" @click="deleting = { id, d }">Delete</MrButton>
            </div>
            <div v-if="dashboards.length === 0" class="px-5 py-6 text-sm text-muted">No dashboards in this profile yet.</div>
        </div>
    </div>

    <MrModal v-if="creating" title="New dashboard" @close="creating = false">
        <form class="space-y-3" @submit.prevent="create">
            <MrInput v-model="newName" label="Name" description="Unique in this profile; the router serves it at /d/<name>" />
            <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="creating = false">Cancel</MrButton>
            <MrButton :disabled="!newName.trim()" @click="create">Create</MrButton>
        </template>
    </MrModal>

    <MrModal v-if="deleting" title="Delete dashboard" @close="deleting = null">
        <p class="text-sm text-subtle">
            Delete <strong class="text-foreground">{{ deleting.d.name }}</strong>? A screen showing it falls back to the dashboard list.
        </p>
        <template #footer>
            <MrButton variant="secondary" @click="deleting = null">Cancel</MrButton>
            <MrButton variant="danger" @click="remove">Delete</MrButton>
        </template>
    </MrModal>

    <CopyDashboardDialog
        v-if="copying"
        :engine-id="engineId"
        :dashboard-id="copying.id"
        :dashboard="copying.d"
        @done="(m) => { toast.show(m, 'info'); copying = null; }"
        @close="copying = null"
    />
</template>

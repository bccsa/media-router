<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { Dashboard } from '@media-router/shared-types';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';
import { managerSource } from '@/dashboard/managerSource';
import { useSubscription } from '@/dashboard/useValue';
import { routersOf } from '@/dashboard/paths';
import { useToast } from '@/composables/useToast';

/** Manager dashboards (ADR-0026): they mix routers and live on the manager. */
const router = useRouter();
const toast = useToast();
const source = managerSource();
useSubscription(source, () => ['/dashboards', '/engines/+/info/name']);

const names = computed(() => {
    const engines = source.get<Record<string, any>>('/engines') ?? {};
    return (id: string) => (engines[id]?.info?.name as string) || id;
});
const dashboards = computed(() =>
    Object.entries(source.get<Record<string, Dashboard>>('/dashboards') ?? {})
        .map(([id, d]) => ({ id, d, routers: routersOf(d).map(names.value) }))
        .sort((a, b) => a.d.name.localeCompare(b.d.name)),
);

/** One name prompt for New and Duplicate. */
const naming = ref<{ title: string; from?: string } | null>(null);
const name = ref('');
const error = ref('');
const deleting = ref<{ id: string; d: Dashboard } | null>(null);

function ask(title: string, from?: string, initial = '') {
    naming.value = { title, from };
    name.value = initial;
    error.value = '';
}

async function submit() {
    const n = name.value.trim();
    const from = naming.value?.from;
    try {
        const { id } = from
            ? await source.call<{ id: string }>(`/dashboards/${from}`, 'duplicate', { name: n })
            : await source.call<{ id: string }>('/dashboards', 'save', { dashboard: shared.newDashboard(n) });
        naming.value = null;
        router.push({ path: `/dashboards/${id}`, query: from ? {} : { edit: '1' } });
    } catch (err) {
        error.value = err instanceof Error ? err.message : 'Failed';
    }
}

async function remove() {
    const target = deleting.value;
    deleting.value = null;
    if (!target) return;
    try {
        await source.call(`/dashboards/${target.id}`, 'delete', {});
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
                <div class="text-sm text-muted">Across routers, served by this manager. A router's own dashboards are on its page.</div>
            </div>
            <MrButton size="sm" @click="ask('New dashboard')">New dashboard</MrButton>
        </div>

        <div class="rounded-lg overflow-hidden bg-card border border-border">
            <div v-for="({ id, d, routers }, i) in dashboards" :key="id" class="px-5 py-3 flex items-center gap-3" :class="i > 0 ? 'border-t border-border-alt' : ''">
                <RouterLink :to="`/dashboards/${id}`" class="flex-1 min-w-0">
                    <div class="text-sm text-foreground truncate">{{ d.name }}</div>
                    <div class="text-xs text-muted truncate">
                        {{ d.widgets.length }} widgets · {{ routers.length ? routers.join(', ') : 'no routers yet' }}
                    </div>
                </RouterLink>
                <MrButton size="sm" variant="secondary" @click="router.push({ path: `/dashboards/${id}`, query: { edit: '1' } })">Edit</MrButton>
                <MrButton size="sm" variant="secondary" @click="ask(`Duplicate “${d.name}”`, id, `${d.name} copy`)">Duplicate</MrButton>
                <MrButton size="sm" variant="danger" @click="deleting = { id, d }">Delete</MrButton>
            </div>
            <div v-if="dashboards.length === 0" class="px-5 py-6 text-sm text-muted">No manager dashboards yet.</div>
        </div>
    </div>

    <MrModal v-if="naming" :title="naming.title" @close="naming = null">
        <form class="space-y-3" @submit.prevent="submit">
            <MrInput v-model="name" label="Name" description="Unique among this manager's dashboards" />
            <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
        </form>
        <template #footer>
            <MrButton variant="secondary" @click="naming = null">Cancel</MrButton>
            <MrButton :disabled="!name.trim()" @click="submit">{{ naming.from ? 'Duplicate' : 'Create' }}</MrButton>
        </template>
    </MrModal>

    <MrModal v-if="deleting" title="Delete dashboard" @close="deleting = null">
        <p class="text-sm text-subtle">Delete <strong class="text-foreground">{{ deleting.d.name }}</strong> and its history?</p>
        <template #footer>
            <MrButton variant="secondary" @click="deleting = null">Cancel</MrButton>
            <MrButton variant="danger" @click="remove">Delete</MrButton>
        </template>
    </MrModal>
</template>

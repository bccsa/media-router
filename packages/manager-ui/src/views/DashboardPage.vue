<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Dashboard } from '@media-router/shared-types';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import DashboardView from '@/dashboard/DashboardView.vue';
import DashboardEditor from '@/dashboard/editor/DashboardEditor.vue';
import DashboardHistoryDialog from '@/dashboard/manage/DashboardHistoryDialog.vue';
import { managerSource, routerScope } from '@/dashboard/managerSource';
import { useSubscription } from '@/dashboard/useValue';
import { errorCode } from '@/tree/TreeClient';

/**
 * One dashboard in the manager (ADR-0026): a router's (with `engineId`,
 * router-relative paths) or a manager dashboard (absolute paths, routers
 * picked per widget). Live through the manager, edited here.
 */
const props = defineProps<{ engineId?: string; dashboardId: string }>();
const route = useRoute();
const router = useRouter();

const at = computed(() => (props.engineId ? `/engines/${props.engineId}` : ''));
const source = computed(() => (props.engineId ? routerScope(props.engineId) : managerSource()));
const back = computed(() => (props.engineId ? `${at.value}/dashboards` : '/dashboards'));
useSubscription(source.value, () => [
    `${at.value}/dashboards/${props.dashboardId}`,
    ...(props.engineId ? [`${at.value}/info/online`, `${at.value}/info/features`, `${at.value}/info/name`] : []),
]);

const dashboard = computed(() => source.value.get<Dashboard>(`${at.value}/dashboards/${props.dashboardId}`));
const offline = computed(() => !!props.engineId && source.value.get(`${at.value}/info/online`) === false);
const upgraded = computed(() => {
    const f = source.value.get(`${at.value}/info/features`);
    return !props.engineId || (Array.isArray(f) && f.includes('dashboards'));
});
const loaded = computed(() => source.value.loaded(`${at.value}/dashboards/${props.dashboardId}`));

const editing = ref(route.query.edit === '1');
const saving = ref(false);
const error = ref('');
const conflict = ref<{ d: Dashboard; baseRev: number } | null>(null);
const history = ref(false);

watch(editing, () => (error.value = ''));

async function save(d: Dashboard, baseRev: number, force = false) {
    saving.value = true;
    error.value = '';
    try {
        // A plain copy: the draft is reactive, and a Proxy can't be cloned or sent as is.
        const { rev: _rev, ...body } = JSON.parse(JSON.stringify(d)) as Dashboard;
        await source.value.call(`${at.value}/dashboards`, 'save', { id: props.dashboardId, dashboard: body, baseRev, force });
        editing.value = false;
        conflict.value = null;
        router.replace({ query: {} });
    } catch (err) {
        if (errorCode(err) === 'conflict') conflict.value = { d, baseRev };
        else error.value = err instanceof Error ? err.message : 'Save failed';
    } finally {
        saving.value = false;
    }
}

function stopEditing() {
    editing.value = false;
    conflict.value = null;
    router.replace({ query: {} });
}
</script>

<template>
    <div class="h-full flex flex-col min-h-0">
        <div v-if="!editing" class="flex items-center gap-3 px-4 py-2 border-b border-border bg-card">
            <RouterLink :to="back" class="text-sm text-accent-fg hover:underline">← Dashboards</RouterLink>
            <span class="font-semibold text-foreground truncate">{{ dashboard?.name ?? '' }}</span>
            <span v-if="engineId" class="text-xs text-muted truncate">{{ source.get(`${at}/info/name`) ?? engineId }}</span>
            <span v-if="dashboard && !upgraded && !offline" class="text-xs text-yellow-300">appears on the router's screen after its upgrade</span>
            <div class="flex-1" />
            <MrButton v-if="dashboard && !engineId" size="sm" variant="secondary" @click="history = true">History</MrButton>
            <MrButton v-if="dashboard" size="sm" @click="editing = true">Edit</MrButton>
        </div>

        <div v-if="!dashboard" class="p-6 text-muted text-sm">{{ loaded ? 'Dashboard not found.' : 'Loading…' }}</div>
        <DashboardEditor
            v-else-if="editing"
            :key="dashboardId"
            :dashboard="dashboard"
            :source="source"
            :pick-router="!engineId"
            :saving="saving"
            :error="error"
            class="flex-1"
            @save="(d, rev) => save(d, rev)"
            @cancel="stopEditing"
        />
        <div v-else class="relative flex-1 min-h-0">
            <!-- The manager's own navigation replaces the dashboard menu here. -->
            <DashboardView :dashboard="dashboard" :dashboard-id="dashboardId" :source="source" :offline="offline" />
        </div>
    </div>

    <MrModal v-if="conflict" title="Someone else saved this dashboard" @close="conflict = null">
        <p class="text-sm text-subtle">It changed since you started editing. Overwrite their version with yours, or drop your edits and load theirs?</p>
        <template #footer>
            <MrButton variant="secondary" @click="stopEditing">Load theirs</MrButton>
            <MrButton variant="danger" :loading="saving" @click="save(conflict!.d, conflict!.baseRev, true)">Overwrite</MrButton>
        </template>
    </MrModal>
    <DashboardHistoryDialog v-if="history" :dashboard-id="dashboardId" @close="history = false" />
</template>

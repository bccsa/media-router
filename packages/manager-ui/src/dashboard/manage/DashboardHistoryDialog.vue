<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { Dashboard } from '@media-router/shared-types';
import MrModal from '@/components/common/MrModal.vue';
import MrButton from '@/components/common/MrButton.vue';
import { managerSource } from '../managerSource';

/** A manager dashboard's saved versions (at most one per 10 minutes, the last 10), with restore. */
const props = defineProps<{ dashboardId: string }>();
const emit = defineEmits<{ close: [] }>();
const source = managerSource();

const versions = ref<Array<{ id: number; saved_at: string; d: Dashboard }>>([]);
const error = ref('');
const confirming = ref<number | null>(null);

onMounted(async () => {
    try {
        const rows = await source.call<Array<{ id: number; saved_at: string; config: string }>>(`/dashboards/${props.dashboardId}`, 'history', {});
        versions.value = rows.map((r) => ({ id: r.id, saved_at: r.saved_at, d: JSON.parse(r.config) as Dashboard }));
    } catch (err) {
        error.value = err instanceof Error ? err.message : 'Could not load the history';
    }
});

async function restore(versionId: number) {
    confirming.value = null;
    try {
        await source.call(`/dashboards/${props.dashboardId}`, 'rollback', { versionId });
        emit('close');
    } catch (err) {
        error.value = err instanceof Error ? err.message : 'Restore failed';
    }
}
</script>

<template>
    <MrModal title="Dashboard history" @close="emit('close')">
        <div class="space-y-1 max-h-96 overflow-auto">
            <div v-for="v in versions" :key="v.id" class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-accent-muted">
                <div class="flex-1 min-w-0">
                    <div class="text-sm text-foreground">{{ new Date(`${v.saved_at}Z`).toLocaleString() }}</div>
                    <div class="text-xs text-muted truncate">{{ v.d.name }} · {{ v.d.widgets.length }} widgets · {{ v.d.cols }} × {{ v.d.rows }}</div>
                </div>
                <MrButton v-if="confirming !== v.id" size="sm" variant="secondary" @click="confirming = v.id">Restore</MrButton>
                <MrButton v-else size="sm" variant="danger" @click="restore(v.id)">Restore it</MrButton>
            </div>
            <div v-if="!error && versions.length === 0" class="text-sm text-muted">No saved versions yet.</div>
            <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
        </div>
    </MrModal>
</template>

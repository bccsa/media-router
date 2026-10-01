<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Dashboard } from '@media-router/shared-types';
import MrModal from '@/components/common/MrModal.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrButton from '@/components/common/MrButton.vue';
import { managerSource } from '../managerSource';
import { useModules, type ModuleItem } from '../editor/useModules';
import { modulePathsOf } from '../editor/useDraft';
import { useSubscription } from '../useValue';

/**
 * Copy a router dashboard to another router or profile (ADR-0026). Module
 * ids differ between routers, so each module the dashboard uses is mapped:
 * same display name first, then same plugin; the rest show as missing there.
 */
const props = defineProps<{ engineId: string; dashboardId: string; dashboard: Dashboard }>();
const emit = defineEmits<{ done: [message: string]; close: [] }>();
const source = managerSource();

useSubscription(source, () => ['/engines/+/info/name', '/engines/+/profiles']);
const engines = computed(() =>
    Object.entries(source.get<Record<string, any>>('/engines') ?? {})
        .map(([id, e]) => ({ value: id, label: (e?.info?.name as string) || id }))
        .sort((a, b) => a.label.localeCompare(b.label)),
);
const toEngine = ref(props.engineId);
const profileRows = computed(() => source.get<Record<string, { active?: boolean }>>(`/engines/${toEngine.value}/profiles`) ?? {});
const profiles = computed(() => Object.keys(profileRows.value).map((p) => ({ value: p, label: profileRows.value[p]?.active ? `${p} (active)` : p })));
const toProfile = ref('');
watch(
    profileRows,
    (rows) => {
        if (!(toProfile.value in rows)) toProfile.value = Object.keys(rows).find((p) => rows[p]?.active) ?? Object.keys(rows)[0] ?? '';
    },
    { immediate: true },
);

const sameTarget = computed(() => toEngine.value === props.engineId && profileRows.value[toProfile.value]?.active);
const name = ref(`${props.dashboard.name} copy`);

const usedIds = computed(() => [
    ...new Set(props.dashboard.widgets.flatMap(modulePathsOf).map((p) => p.split('/').pop()!)),
]);
const sourceModules = useModules(source, () => `/engines/${props.engineId}`);
const targets = ref<ModuleItem[]>([]);
const mapping = ref<Record<string, string>>({});
const error = ref('');
const busy = ref(false);

function defaults(): Record<string, string> {
    const out: Record<string, string> = {};
    const taken = new Set<string>();
    for (const id of usedIds.value) {
        const src = sourceModules.value.find((m) => m.id === id);
        const free = (t: ModuleItem) => !taken.has(t.id);
        const pick = targets.value.find((t) => free(t) && t.name === src?.name) ?? targets.value.find((t) => free(t) && t.pluginId === src?.pluginId);
        if (pick) {
            out[id] = pick.id;
            taken.add(pick.id);
        }
    }
    return out;
}

watch(
    [toEngine, toProfile],
    async ([e, p]) => {
        targets.value = [];
        if (!e || !p) return;
        try {
            const cfg = await source.call<{ modules?: Record<string, { displayName?: string; pluginId?: string }> }>(`/engines/${e}/profiles/${p}`, 'config');
            targets.value = Object.entries(cfg.modules ?? {})
                .map(([id, m]) => ({ id, name: m.displayName || id, pluginId: m.pluginId ?? '' }))
                .sort((a, b) => a.name.localeCompare(b.name));
            mapping.value = defaults();
        } catch (err) {
            error.value = err instanceof Error ? err.message : 'Could not read that profile';
        }
    },
    { immediate: true },
);
watch(sourceModules, () => (mapping.value = defaults()));
watch(sameTarget, (same) => (name.value = same ? `${props.dashboard.name} copy` : props.dashboard.name), { immediate: true });

const targetOptions = computed(() => [{ value: '', label: '— not mapped —' }, ...targets.value.map((t) => ({ value: t.id, label: `${t.name} (${t.pluginId})` }))]);
const sourceName = (id: string) => sourceModules.value.find((m) => m.id === id)?.name ?? id;

function setMap(id: string, to: string) {
    const next = { ...mapping.value };
    if (to) next[id] = to;
    else delete next[id];
    mapping.value = next;
}

async function copy() {
    busy.value = true;
    error.value = '';
    try {
        await source.call(`/engines/${props.engineId}/dashboards/${props.dashboardId}`, 'copy', {
            toEngine: toEngine.value,
            toProfile: toProfile.value,
            name: name.value.trim(),
            modules: mapping.value,
        });
        emit('done', `Copied to ${toEngine.value} / ${toProfile.value}`);
    } catch (err) {
        error.value = err instanceof Error ? err.message : 'Copy failed';
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <MrModal :title="`Copy “${dashboard.name}”`" @close="emit('close')">
        <div class="space-y-3">
            <MrSelect v-model="toEngine" label="Router" :options="engines" searchable />
            <MrSelect v-model="toProfile" label="Profile" :options="profiles" />
            <MrInput v-model="name" label="Name there" />
            <div v-if="usedIds.length > 0">
                <div class="text-xs font-medium text-foreground mb-1">Modules</div>
                <div v-for="id in usedIds" :key="id" class="flex items-center gap-2 mb-1.5">
                    <span class="text-xs text-subtle w-2/5 shrink-0 truncate">{{ sourceName(id) }}</span>
                    <span class="text-muted">→</span>
                    <div class="flex-1 min-w-0">
                        <MrSelect :model-value="mapping[id] ?? ''" :options="targetOptions" searchable @update:model-value="(v) => setMap(id, String(v))" />
                    </div>
                </div>
            </div>
            <div v-if="error" class="text-sm text-red-400">{{ error }}</div>
        </div>
        <template #footer>
            <MrButton variant="secondary" @click="emit('close')">Cancel</MrButton>
            <MrButton :loading="busy" :disabled="!name.trim() || !toProfile" @click="copy">Copy</MrButton>
        </template>
    </MrModal>
</template>

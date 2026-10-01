<script setup lang="ts">
import { computed, ref } from 'vue';
import MrModal from '@/components/common/MrModal.vue';
import MrInput from '@/components/common/MrInput.vue';
import { useModules, useEntries } from './useModules';
import { useRouters } from '../useRouters';
import type { EntryKind, ValueEntry } from '../entries';
import type { DashboardSource } from '../source';

/**
 * Drill-down (ADR-0026): router (manager dashboards only) → module or the
 * router itself → the values this widget takes.
 */
const props = defineProps<{
    source: DashboardSource;
    accept: (e: ValueEntry) => boolean;
    /** A manager dashboard: start by choosing the router. */
    pickRouter?: boolean;
    title?: string;
}>();
const emit = defineEmits<{ pick: [entry: ValueEntry]; close: [] }>();

const router = ref<string | null>(null);
const moduleId = ref<string | null>(null);
const filter = ref('');
const base = computed(() => (!props.pickRouter ? '' : router.value ? `/engines/${router.value}` : null));

const { groups: routerGroups } = useRouters(props.source, () => !!props.pickRouter);
const routers = computed(() => routerGroups.value.flatMap((g) => g.routers));
const modules = useModules(props.source, () => base.value);
const entries = useEntries(props.source, () => base.value, () => moduleId.value);

const shownModules = computed(() => {
    const q = filter.value.trim().toLowerCase();
    return q ? modules.value.filter((m) => `${m.name} ${m.pluginId}`.toLowerCase().includes(q)) : modules.value;
});

const GROUPS: Array<[EntryKind, string]> = [
    ['setting', 'Settings'],
    ['status', 'Status'],
    ['state', 'State'],
    ['vu', 'Levels'],
    ['field', 'Module'],
    ['router', 'Router'],
];
const groups = computed(() =>
    GROUPS.map(([kind, title]) => ({ title, items: entries.value.filter((e) => e.kind === kind && props.accept(e)) })).filter((g) => g.items.length > 0),
);

function detail(e: ValueEntry): string {
    const d = e.desc;
    const parts: string[] = [];
    if (typeof d.min === 'number' && typeof d.max === 'number') parts.push(`${d.min}–${d.max}${d.unit ? ` ${d.unit}` : ''}`);
    else if (d.unit) parts.push(d.unit);
    if (d.access === 'read') parts.push('read-only');
    else if (d.apply === 'restart') parts.push('applies on restart');
    return parts.join(' · ');
}

const moduleName = computed(() => (moduleId.value === 'router' ? 'Router' : (modules.value.find((m) => m.id === moduleId.value)?.name ?? moduleId.value)));
const routerName = computed(() => routers.value.find((r) => r.id === router.value)?.name ?? router.value);

function back() {
    if (moduleId.value) moduleId.value = null;
    else router.value = null;
}
</script>

<template>
    <MrModal :title="title ?? 'Choose a value'" @close="emit('close')">
        <div class="flex items-center gap-2 mb-3 text-xs text-muted">
            <button v-if="moduleId || (pickRouter && router)" class="text-accent-fg hover:underline" @click="back">← Back</button>
            <span v-if="pickRouter && router">{{ routerName }}</span>
            <span v-if="moduleId">› {{ moduleName }}</span>
        </div>

        <div v-if="pickRouter && !router" class="space-y-1 max-h-96 overflow-auto">
            <template v-for="g in routerGroups" :key="g.id">
                <div class="picker-group">
                    <span class="picker-group-dot" :style="{ background: g.color || 'var(--text-muted, #94a3b8)' }" />
                    {{ g.name }}
                </div>
                <button v-for="r in g.routers" :key="r.id" class="picker-row picker-row-in" @click="router = r.id">{{ r.name }}</button>
            </template>
        </div>

        <template v-else-if="!moduleId">
            <MrInput v-model="filter" placeholder="Search modules" />
            <div class="space-y-1 max-h-96 overflow-auto mt-2">
                <button class="picker-row" @click="moduleId = 'router'"><strong>Router</strong> <span class="text-muted">— run state, load, identity</span></button>
                <button v-for="m in shownModules" :key="m.id" class="picker-row" @click="moduleId = m.id">
                    {{ m.name }} <span class="text-muted text-xs">{{ m.pluginId }}</span>
                </button>
            </div>
        </template>

        <div v-else class="max-h-96 overflow-auto space-y-3">
            <div v-for="g in groups" :key="g.title">
                <div class="text-[11px] uppercase tracking-wide text-muted mb-1">{{ g.title }}</div>
                <button v-for="e in g.items" :key="e.path" class="picker-row" @click="emit('pick', e)">
                    {{ e.label }} <span class="text-muted text-xs">{{ detail(e) }}</span>
                </button>
            </div>
            <div v-if="groups.length === 0" class="text-sm text-muted">Nothing here fits this widget.</div>
        </div>
    </MrModal>
</template>

<style scoped>
.picker-group {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 10px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
}
.picker-group-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.picker-row-in {
    padding-left: 24px;
}
.picker-row {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text-primary);
}
.picker-row:hover {
    background: var(--accent-muted);
}
</style>

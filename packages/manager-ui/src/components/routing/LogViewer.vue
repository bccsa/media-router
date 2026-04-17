<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useLogStore, LEVEL_LABELS, LEVEL_COLORS, type LogEntry } from '@/stores/logs';
import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';

const props = defineProps<{ engineId: string }>();

const logStore = useLogStore();
const socket = useSocketStore();
const engineStore = useEngineStore();

// Per-level visibility. Default: info + warn + error (ignore noise from trace/debug)
const enabledLevels = ref<Set<number>>(new Set([30, 40, 50]));
function toggleLevel(level: number) {
    const s = new Set(enabledLevels.value);
    if (s.has(level)) s.delete(level);
    else s.add(level);
    enabledLevels.value = s;
}
const searchQuery = ref('');
const autoScroll = ref(true);
const scrollEl = ref<HTMLElement | null>(null);
const showSourceFilter = ref(false);
const filterBtnRef = ref<HTMLElement | null>(null);
const filterPos = ref({ x: 0, y: 0 });

function toggleSourceFilter() {
    showSourceFilter.value = !showSourceFilter.value;
    if (showSourceFilter.value && filterBtnRef.value) {
        const rect = filterBtnRef.value.getBoundingClientRect();
        filterPos.value = { x: rect.left, y: rect.top };
    }
}

// Build list of all unique source names from log entries
const allSources = computed(() => {
    const entries = logStore.getEntries(props.engineId);
    const names = new Set<string>();
    for (const e of entries) {
        if (e.name) names.add(e.name);
    }
    return Array.from(names).sort();
});

// Sources that are hidden (deselected)
const hiddenSources = ref(new Set<string>());

function toggleSource(source: string) {
    const s = new Set(hiddenSources.value);
    if (s.has(source)) s.delete(source);
    else s.add(source);
    hiddenSources.value = s;
}

function selectAll() { hiddenSources.value = new Set(); }
function deselectAll() { hiddenSources.value = new Set(allSources.value); }

// Request history on mount + scroll to bottom
onMounted(async () => {
    socket.requestLogHistory(props.engineId);
    await nextTick();
    if (scrollEl.value) {
        scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
});

const filteredEntries = computed(() => {
    let entries = logStore.getEntries(props.engineId);

    // Filter by source
    if (hiddenSources.value.size > 0) {
        entries = entries.filter((e) => !e.name || !hiddenSources.value.has(e.name));
    }

    // Filter by level (per-level toggle, not threshold)
    entries = entries.filter((e) => enabledLevels.value.has(e.level));

    // Filter by search
    if (searchQuery.value) {
        const q = searchQuery.value.toLowerCase();
        entries = entries.filter((e) => {
            const hay = [
                e.msg,
                e.name,
                e.instanceId as string | undefined,
                (e as any).module as string | undefined,
                (e as any).moduleId as string | undefined,
            ].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(q);
        });
    }

    return entries;
});

// Auto-scroll to bottom when new entries arrive or history loads
watch(() => filteredEntries.value.length, async () => {
    if (autoScroll.value && scrollEl.value) {
        await nextTick();
        scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
}, { immediate: true });

function formatTime(time: string): string {
    try {
        const d = new Date(time);
        return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    } catch {
        return time;
    }
}

function levelLabel(level: number): string {
    return (LEVEL_LABELS[level] ?? 'unknown').toUpperCase().padEnd(5);
}

function levelColor(level: number): string {
    return LEVEL_COLORS[level] ?? 'var(--text-muted)';
}

// Get module display name for an instanceId
function getModuleName(instanceId: string): string | undefined {
    const engine = engineStore.getEngine(props.engineId);
    return engine?.modules[instanceId]?.displayName;
}

const levels = [
    { value: 20, label: 'Debug' },
    { value: 30, label: 'Info' },
    { value: 40, label: 'Warn' },
    { value: 50, label: 'Error' },
];
</script>

<template>
    <div class="flex flex-col h-full">
        <!-- Toolbar -->
        <div class="flex items-center gap-2 px-3 py-1.5 shrink-0 overflow-x-auto border-b border-border bg-card">
            <!-- Level filter -->
            <div class="flex items-center gap-0.5 shrink-0">
                <button v-for="lvl in levels" :key="lvl.value"
                        @click="toggleLevel(lvl.value)"
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                        :class="enabledLevels.has(lvl.value) ? 'bg-accent-muted text-accent-fg' : 'bg-transparent text-muted'">
                    {{ lvl.label }}
                </button>
            </div>

            <!-- Source filter -->
            <div class="shrink-0">
                <button ref="filterBtnRef" @click="toggleSourceFilter"
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1"
                        :class="hiddenSources.size > 0 ? 'bg-accent-muted text-accent-fg' : 'bg-transparent text-muted'">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                    </svg>
                    Filter{{ hiddenSources.size > 0 ? ` (${hiddenSources.size})` : '' }}
                </button>
            </div>

            <!-- Search -->
            <input v-model="searchQuery" placeholder="Search..."
                   @keydown.stop
                   class="flex-1 px-2 py-0.5 text-xs rounded-md min-w-0 bg-input border border-border text-foreground" />

            <!-- Auto-scroll toggle -->
            <button @click="autoScroll = !autoScroll"
                    class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                    :class="autoScroll ? 'bg-accent-muted text-accent-fg' : 'bg-transparent text-muted'">
                Auto
            </button>

            <!-- Clear -->
            <button @click="logStore.clear(props.engineId)"
                    class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 text-muted">
                Clear
            </button>

            <!-- Count -->
            <span class="text-[10px] tabular-nums shrink-0 text-muted">
                {{ filteredEntries.length }}
            </span>
        </div>

        <!-- Log entries -->
        <div ref="scrollEl" class="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed bg-surface"
             @scroll="() => {
                 if (scrollEl) {
                     const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 50;
                     if (!atBottom) autoScroll = false;
                     else autoScroll = true;
                 }
             }">
            <div v-if="filteredEntries.length === 0" class="p-4 text-center text-xs text-muted">
                No log entries
            </div>
            <div v-for="(entry, i) in filteredEntries" :key="i"
                 class="flex gap-2 px-3 py-px hover:bg-white/5 whitespace-nowrap">
                <span class="shrink-0 tabular-nums text-muted">{{ formatTime(entry.time) }}</span>
                <span class="shrink-0 w-10" :style="{ color: levelColor(entry.level) }">{{ levelLabel(entry.level) }}</span>
                <span class="shrink-0 max-w-[120px] truncate text-muted">{{ entry.name }}</span>
                <span class="break-all whitespace-normal text-foreground">
                    {{ entry.msg }}
                    <template v-if="entry.instanceId">
                        <span class="text-muted"> [{{ getModuleName(entry.instanceId as string) || entry.instanceId }}]</span>
                    </template>
                </span>
            </div>
        </div>

        <!-- Source filter dropdown (fixed position to avoid clipping) -->
        <Teleport to="body">
            <div v-if="showSourceFilter" class="fixed inset-0 z-[998]" @click="showSourceFilter = false" />
            <div v-if="showSourceFilter"
                 class="fixed w-56 rounded-lg shadow-xl py-1 max-h-60 overflow-y-auto z-[999] bg-card border border-border"
                 :style="{
                     left: filterPos.x + 'px',
                     top: (filterPos.y - 4) + 'px',
                     transform: 'translateY(-100%)',
                 }">
                <div class="flex gap-2 px-3 py-1 mb-1 border-b border-border-alt">
                    <button @click="selectAll" class="text-[10px] text-accent-fg">All</button>
                    <button @click="deselectAll" class="text-[10px] text-muted">None</button>
                </div>
                <label v-for="source in allSources" :key="source"
                       class="flex items-center gap-2 px-3 py-0.5 text-[11px] cursor-pointer hover:bg-white/5 text-foreground">
                    <input type="checkbox" :checked="!hiddenSources.has(source)"
                           @change="toggleSource(source)"
                           class="w-3 h-3 rounded accent-emerald-500" />
                    <span class="truncate">{{ getModuleName(source) || source }}</span>
                </label>
            </div>
        </Teleport>
    </div>
</template>

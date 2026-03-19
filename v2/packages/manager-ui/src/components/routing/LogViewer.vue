<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useLogStore, LEVEL_LABELS, LEVEL_COLORS, type LogEntry } from '@/stores/logs';
import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';

const props = defineProps<{ engineId: string }>();

const logStore = useLogStore();
const socket = useSocketStore();
const engineStore = useEngineStore();

const minLevel = ref(30); // info
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
    // Also add module display names
    const engine = engineStore.getEngine(props.engineId);
    if (engine?.modules) {
        for (const mod of Object.values(engine.modules)) {
            names.add(mod.instanceId);
        }
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
        entries = entries.filter((e) => {
            // Check both name and instanceId against hidden list
            if (e.name && hiddenSources.value.has(e.name)) return false;
            if (e.instanceId && hiddenSources.value.has(e.instanceId as string)) return false;
            return true;
        });
    }

    // Filter by level
    entries = entries.filter((e) => e.level >= minLevel.value);

    // Filter by search
    if (searchQuery.value) {
        const q = searchQuery.value.toLowerCase();
        entries = entries.filter((e) =>
            e.msg?.toLowerCase().includes(q) ||
            e.name?.toLowerCase().includes(q) ||
            (e.instanceId as string | undefined)?.toLowerCase().includes(q) ||
            false
        );
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
    { value: 10, label: 'Trace' },
    { value: 20, label: 'Debug' },
    { value: 30, label: 'Info' },
    { value: 40, label: 'Warn' },
    { value: 50, label: 'Error' },
];
</script>

<template>
    <div class="flex flex-col h-full">
        <!-- Toolbar -->
        <div class="flex items-center gap-2 px-3 py-1.5 shrink-0 overflow-x-auto"
             :style="{ borderBottom: '1px solid var(--border-primary)', backgroundColor: 'var(--bg-card)' }">
            <!-- Level filter -->
            <div class="flex items-center gap-0.5 shrink-0">
                <button v-for="lvl in levels" :key="lvl.value"
                        @click="minLevel = lvl.value"
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                        :style="{
                            backgroundColor: minLevel <= lvl.value ? 'var(--accent-muted)' : 'transparent',
                            color: minLevel <= lvl.value ? 'var(--accent-text)' : 'var(--text-muted)',
                        }">
                    {{ lvl.label }}
                </button>
            </div>

            <!-- Source filter -->
            <div class="shrink-0">
                <button ref="filterBtnRef" @click="toggleSourceFilter"
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium flex items-center gap-1"
                        :style="{
                            backgroundColor: hiddenSources.size > 0 ? 'var(--accent-muted)' : 'transparent',
                            color: hiddenSources.size > 0 ? 'var(--accent-text)' : 'var(--text-muted)',
                        }">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                    </svg>
                    Filter{{ hiddenSources.size > 0 ? ` (${hiddenSources.size})` : '' }}
                </button>
            </div>

            <!-- Search -->
            <input v-model="searchQuery" placeholder="Search..."
                   class="flex-1 px-2 py-0.5 text-xs rounded-md min-w-0"
                   :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }" />

            <!-- Auto-scroll toggle -->
            <button @click="autoScroll = !autoScroll"
                    class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                    :style="{
                        backgroundColor: autoScroll ? 'var(--accent-muted)' : 'transparent',
                        color: autoScroll ? 'var(--accent-text)' : 'var(--text-muted)',
                    }">
                Auto
            </button>

            <!-- Clear -->
            <button @click="logStore.clear(props.engineId)"
                    class="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0"
                    :style="{ color: 'var(--text-muted)' }">
                Clear
            </button>

            <!-- Count -->
            <span class="text-[10px] tabular-nums shrink-0" :style="{ color: 'var(--text-muted)' }">
                {{ filteredEntries.length }}
            </span>
        </div>

        <!-- Log entries -->
        <div ref="scrollEl" class="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed"
             :style="{ backgroundColor: 'var(--bg-primary)' }"
             @scroll="() => {
                 if (scrollEl) {
                     const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 50;
                     if (!atBottom) autoScroll = false;
                     else autoScroll = true;
                 }
             }">
            <div v-if="filteredEntries.length === 0" class="p-4 text-center text-xs" :style="{ color: 'var(--text-muted)' }">
                No log entries
            </div>
            <div v-for="(entry, i) in filteredEntries" :key="i"
                 class="flex gap-2 px-3 py-px hover:bg-white/5 whitespace-nowrap">
                <span class="shrink-0 tabular-nums" :style="{ color: 'var(--text-muted)' }">{{ formatTime(entry.time) }}</span>
                <span class="shrink-0 w-10" :style="{ color: levelColor(entry.level) }">{{ levelLabel(entry.level) }}</span>
                <span class="shrink-0 max-w-[120px] truncate" :style="{ color: 'var(--text-muted)' }">{{ entry.name }}</span>
                <span class="break-all whitespace-normal" :style="{ color: 'var(--text-primary)' }">
                    {{ entry.msg }}
                    <template v-if="entry.instanceId">
                        <span :style="{ color: 'var(--text-muted)' }"> [{{ getModuleName(entry.instanceId as string) || entry.instanceId }}]</span>
                    </template>
                </span>
            </div>
        </div>

        <!-- Source filter dropdown (fixed position to avoid clipping) -->
        <Teleport to="body">
            <div v-if="showSourceFilter" class="fixed inset-0 z-[998]" @click="showSourceFilter = false" />
            <div v-if="showSourceFilter"
                 class="fixed w-56 rounded-lg shadow-xl py-1 max-h-60 overflow-y-auto z-[999]"
                 :style="{
                     left: filterPos.x + 'px',
                     top: (filterPos.y - 4) + 'px',
                     transform: 'translateY(-100%)',
                     backgroundColor: 'var(--bg-card)',
                     border: '1px solid var(--border-primary)',
                 }">
                <div class="flex gap-2 px-3 py-1 mb-1" :style="{ borderBottom: '1px solid var(--border-secondary)' }">
                    <button @click="selectAll" class="text-[10px]" :style="{ color: 'var(--accent-text)' }">All</button>
                    <button @click="deselectAll" class="text-[10px]" :style="{ color: 'var(--text-muted)' }">None</button>
                </div>
                <label v-for="source in allSources" :key="source"
                       class="flex items-center gap-2 px-3 py-0.5 text-[11px] cursor-pointer hover:bg-white/5"
                       :style="{ color: 'var(--text-primary)' }">
                    <input type="checkbox" :checked="!hiddenSources.has(source)"
                           @change="toggleSource(source)"
                           class="w-3 h-3 rounded accent-emerald-500" />
                    <span class="truncate">{{ getModuleName(source) || source }}</span>
                </label>
            </div>
        </Teleport>
    </div>
</template>

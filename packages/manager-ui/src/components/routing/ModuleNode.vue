<script setup lang="ts">
import { computed, inject, ref, watch, onUnmounted, type Ref, type Component } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import type { ModuleState } from '@/stores/engines';
import { useVuStore } from '@/stores/vuMeters';
import MrVuMeter from './MrVuMeter.vue';
import * as lucideIcons from 'lucide-vue-next';

const props = defineProps<{ data: ModuleState }>();

// Engine ID injected by RoutingEditor
const engineId = inject<string>('engineId', '');
const vuStore = useVuStore();

// Focus mode injected by RoutingEditor
const focusMode = inject<Ref<boolean>>('focusMode', ref(false));
const focusedModules = inject<Ref<Set<string>>>('focusedModules', ref(new Set()));
const isDimmed = computed(() =>
    focusMode.value && focusedModules.value.size > 0 && !focusedModules.value.has(props.data.instanceId)
);

const showStats = ref(false);

// Close stats modal on Escape
function onStatsKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') showStats.value = false;
}
watch(showStats, (open) => {
    if (open) document.addEventListener('keydown', onStatsKeydown);
    else document.removeEventListener('keydown', onStatsKeydown);
});
onUnmounted(() => document.removeEventListener('keydown', onStatsKeydown));
const hasStats = computed(() =>
    (props.data.statusSections?.length ?? 0) > 0
);

const inputPorts = computed(() => props.data.ports?.filter((p) => p.direction === 'input') ?? []);
const outputPorts = computed(() => props.data.ports?.filter((p) => p.direction === 'output') ?? []);

// Show VU meters if the module has any audio/pcm ports
const hasAudio = computed(() =>
    props.data.ports?.some((p) => p.streamType === 'audio/pcm') ?? false
);
// Read VU data from dedicated reactive store (updates at ~15Hz without triggering full re-render)
const vuChannels = computed(() => {
    const live = vuStore.get(engineId, props.data.instanceId);
    if (live && live.length > 0) return live;
    return [];
});

// Long-press for mobile context menu
const emit = defineEmits<{ 'longpress': [event: TouchEvent] }>();
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

function onTouchStart(e: TouchEvent) {
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        emit('longpress', e);
    }, 500);
}
function onTouchEnd() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}
function onTouchMove() {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

onUnmounted(() => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
});

/**
 * Resolve a Lucide icon component by name.
 * Plugin specifies icon as kebab-case (e.g. "mic", "volume-2", "upload", "download").
 * Lucide exports as PascalCase (e.g. "Mic", "Volume2", "Upload", "Download").
 */
function resolveLucideIcon(name: string): Component | null {
    if (!name) return null;
    // Convert kebab-case to PascalCase: "volume-2" → "Volume2"
    const pascal = name.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
    return (lucideIcons as unknown as Record<string, Component>)[pascal] ?? null;
}

const iconComponent = computed(() => resolveLucideIcon(props.data.icon ?? ''));

const moduleColor = computed(() => props.data.color ?? undefined);

const healthColor = computed(() => {
    switch (props.data.health) {
        case 'ok': return 'var(--health-ok)';
        case 'warning': return 'var(--health-warning)';
        case 'error': return 'var(--health-error)';
        default: return 'var(--health-stopped)';
    }
});

const portColorMap: Record<string, string> = {
    'audio/pcm': 'var(--port-audio-pcm)',
    'audio/opus': 'var(--port-audio-pcm)',
    'audio/aac': 'var(--port-audio-pcm)',
    'muxed/mpegts': 'var(--port-muxed-mpegts)',
    'video/raw': 'var(--port-video-raw)',
    'video/h264': '#e74c3c',
    'video/h265': '#c0392b',
    'text/subtitle': '#9b59b6',
    'data/generic': '#7f8c8d',
};

function formatStatusValue(value: unknown, unit?: string): string {
    if (value === undefined || value === null) return '—';
    const str = typeof value === 'number' ? value.toLocaleString() : String(value);
    return unit ? `${str} ${unit}` : str;
}
</script>

<template>
    <div class="rounded-lg shadow-md select-none relative"
         @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd" @touchmove.passive="onTouchMove"
         :style="{
             backgroundColor: 'var(--bg-card)',
             border: data.health === 'error' ? '2px solid var(--health-error)' : '1px solid var(--border-primary)',
             borderLeft: moduleColor ? `3px solid ${moduleColor}` : undefined,
             width: '200px',
             minHeight: (36 + Math.max(inputPorts.length, outputPorts.length, 1) * 24 + 8) + 'px',
             opacity: data.enabled === false ? 0.4 : isDimmed ? 0.15 : 1,
             transition: 'opacity 0.2s ease',
         }">

        <!-- Header -->
        <div class="flex items-center gap-2 px-3 py-2 relative" :style="{ borderBottom: '1px solid var(--border-secondary)' }">
            <!-- Plugin icon (Lucide) or fallback colored dot -->
            <component v-if="iconComponent" :is="iconComponent" :size="14" :color="moduleColor ?? 'var(--text-muted)'" class="shrink-0" />
            <div v-else class="w-3 h-3 rounded-full shrink-0" :style="{ backgroundColor: moduleColor ?? 'var(--text-muted)' }" />
            <span class="text-xs font-medium truncate flex-1" :style="{ color: 'var(--text-primary)' }">
                {{ data.displayName }}
            </span>
            <span v-if="data.pendingRestart" class="text-[10px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400">
                restart
            </span>
            <button v-if="hasStats" @click.stop="showStats = !showStats"
                    class="w-4 h-4 flex items-center justify-center rounded shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                    :style="{ color: showStats ? 'var(--accent)' : 'var(--text-muted)' }"
                    title="Stats">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <rect x="0" y="5" width="2" height="5" /><rect x="4" y="2" width="2" height="8" /><rect x="8" y="0" width="2" height="10" />
                </svg>
            </button>
            <!-- Health indicator dot (top-right corner) with tooltip -->
            <div class="absolute top-1 right-1 w-[6px] h-[6px] rounded-full group cursor-help" :style="{ backgroundColor: healthColor }">
                <div class="hidden group-hover:block absolute right-0 top-3 w-36 p-2 rounded-md shadow-lg text-[9px] leading-relaxed" style="z-index:9999"
                     :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
                    <div class="flex items-center gap-1.5 mb-0.5"><span class="w-2 h-2 rounded-full inline-block" style="background:#22c55e" /><span :style="{color:'var(--text-primary)'}">Running</span></div>
                    <div class="flex items-center gap-1.5 mb-0.5"><span class="w-2 h-2 rounded-full inline-block" style="background:#f59e0b" /><span :style="{color:'var(--text-primary)'}">Warning</span></div>
                    <div class="flex items-center gap-1.5 mb-0.5"><span class="w-2 h-2 rounded-full inline-block" style="background:#ef4444" /><span :style="{color:'var(--text-primary)'}">Error</span></div>
                    <div class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full inline-block" style="background:#6b7280" /><span :style="{color:'var(--text-primary)'}">Stopped</span></div>
                    <div v-if="data.error" class="mt-1 pt-1 text-red-400 truncate" :style="{ borderTop: '1px solid var(--border-secondary)' }">{{ data.error }}</div>
                </div>
            </div>
        </div>

        <!-- Stats modal (full overlay) -->
        <Teleport to="body">
            <div v-if="showStats && hasStats" class="fixed inset-0 flex items-center justify-center" style="z-index:10000"
                 @click.self="showStats = false">
                <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" />
                <div class="relative w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl shadow-2xl mx-4"
                     :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
                    <!-- Header -->
                    <div class="flex items-center justify-between px-5 py-3 sticky top-0"
                         :style="{ backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border-secondary)' }">
                        <div class="flex items-center gap-2">
                            <component v-if="iconComponent" :is="iconComponent" :size="18" :color="moduleColor ?? 'var(--text-muted)'" />
                            <h2 class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">
                                {{ data.displayName }} — Stats
                            </h2>
                        </div>
                        <button @click="showStats = false" class="p-1 rounded-md hover:bg-white/10"
                                :style="{ color: 'var(--text-muted)' }">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <!-- Sections -->
                    <div class="p-5 space-y-4">
                        <div v-for="section in data.statusSections" :key="section.id">
                            <h3 class="text-xs font-semibold uppercase tracking-wide mb-2"
                                :style="{ color: 'var(--text-muted)' }">
                                {{ section.label }}
                            </h3>
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                                <template v-for="field in section.fields" :key="field.key">
                                    <span class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ field.label }}</span>
                                    <span class="text-xs tabular-nums text-right" :style="{ color: 'var(--text-primary)' }">
                                        {{ formatStatusValue(data.statusData?.[section.id]?.[field.key], field.unit) }}
                                    </span>
                                </template>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Teleport>

        <!-- Port labels -->
        <div class="px-3 py-1 flex justify-between">
            <div class="space-y-1">
                <div v-for="port in inputPorts" :key="port.id" class="h-5 flex items-center">
                    <span v-if="(port.maxConnections ?? -1) === -1" class="text-[8px] opacity-40 mr-0.5">&#8734;</span>
                    <span class="text-[10px] pl-2" :style="{ color: 'var(--text-muted)' }">{{ port.label || port.id }}</span>
                </div>
            </div>
            <div class="space-y-1">
                <div v-for="port in outputPorts" :key="port.id" class="h-5 flex items-center justify-end">
                    <span class="text-[10px] pr-2" :style="{ color: 'var(--text-muted)' }">{{ port.label || port.id }}</span>
                    <span v-if="(port.maxConnections ?? -1) === -1" class="text-[8px] opacity-40 ml-0.5">&#8734;</span>
                </div>
            </div>
        </div>

        <!-- VU Meter (canvas — always visible for audio modules) -->
        <div v-if="hasAudio" class="px-3 py-1" :style="{ height: '16px' }">
            <MrVuMeter :levels="vuChannels" orientation="horizontal" />
        </div>

        <!-- Error -->
        <div v-if="data.error && data.health === 'error'" class="px-3 py-1 text-[10px] text-red-400 truncate">
            {{ data.error }}
        </div>

        <!-- Input handles (left) — hidden if maxConnections=0 -->
        <Handle v-for="(port, i) in inputPorts" :key="'in-' + port.id" :id="port.id" type="target" :position="Position.Left"
                v-show="(port.maxConnections ?? -1) !== 0"
                :style="{ top: (44 + i * 24) + 'px', width: '12px', height: '12px', borderRadius: '50%',
                           backgroundColor: portColorMap[port.streamType] ?? '#6b7280', border: '2px solid var(--bg-primary)' }" />

        <!-- Output handles (right) — hidden if maxConnections=0 -->
        <Handle v-for="(port, i) in outputPorts" :key="'out-' + port.id" :id="port.id" type="source" :position="Position.Right"
                v-show="(port.maxConnections ?? -1) !== 0"
                :style="{ top: (44 + i * 24) + 'px', width: '12px', height: '12px', borderRadius: '50%',
                           backgroundColor: portColorMap[port.streamType] ?? '#6b7280', border: '2px solid var(--bg-primary)' }" />
    </div>
</template>

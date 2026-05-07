<script setup lang="ts">
import { computed, inject, ref, watch, onUnmounted, type Ref, type Component } from 'vue';
import { Handle, Position, useVueFlow } from '@vue-flow/core';
import type { ModuleState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { useVuStore } from '@/stores/vuMeters';
import MrVuMeter from './MrVuMeter.vue';
import { getLucideIcon } from '@/composables/useLucideIcons';
import {
    getInterlockForModule,
    INTERLOCK_DEFAULT_COLOR,
    readableTextOn,
} from '@/composables/useInterlocks';
import { getFaceComponent } from '@/composables/usePluginFaceComponent';
import { patch } from '@/composables/usePatch';

const props = defineProps<{ data: ModuleState }>();

// Engine ID injected by RoutingEditor
const engineId = inject<string>('engineId', '');
const vuStore = useVuStore();
const engineStore = useEngineStore();

const interlock = computed(() =>
    getInterlockForModule(engineStore.getEngine(engineId), props.data.instanceId),
);
const isHotMember = computed(() => {
    if (!interlock.value) return false;
    return props.data.settings?.audioEnabled !== false;
});

// Focus mode injected by RoutingEditor
const focusMode = inject<Ref<boolean>>('focusMode', ref(false));
const focusedModules = inject<Ref<Set<string>>>('focusedModules', ref(new Set()));
const isDimmed = computed(
    () =>
        focusMode.value &&
        focusedModules.value.size > 0 &&
        !focusedModules.value.has(props.data.instanceId),
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
// Merge static sections (from plugin manifest) with dynamic sections (from runtime)
const allStatusSections = computed(() => {
    const staticSections = props.data.statusSections ?? [];
    const dynamicSections = props.data.dynamicStatusSections ?? [];
    return [...staticSections, ...dynamicSections];
});

const moduleBadges = computed(() => props.data.badges ?? []);
const faceWidgets = computed(() => props.data.faceWidgets ?? []);

// Plugin-provided face component: if the plugin ships a `ui/NodeFace.vue`,
// it's rendered in the body of the card. Declarative widgets (`faceWidgets`)
// still work alongside for simpler cases.
const pluginFace = computed(() => getFaceComponent(props.data.pluginId));

// --- Resizable card (opt-in per plugin) ---
//
// When `resizable` is truthy, the user can drag the bottom-right grip to
// resize the card. Size is stored per-instance at `/modules/<id>/size` and
// patched on drag end. Bounds come from the plugin manifest (or sensible
// defaults). Non-resizable plugins use a fixed width + content-driven height.

const DEFAULT_WIDTH = 200;
const DEFAULT_BOUNDS = { minWidth: 160, minHeight: 80, maxWidth: 600, maxHeight: 600 };

const resizable = computed(() => !!props.data.resizable);
const bounds = computed(() => {
    const r = props.data.resizable;
    const custom = typeof r === 'object' && r !== null ? r : {};
    return { ...DEFAULT_BOUNDS, ...custom };
});

// Optimistic local override while the user drags — replaces the stored size
// until drag-end persists. Falls back to the stored size, then the default.
const dragSize = ref<{ width: number; height: number } | null>(null);
const cardWidth = computed(() => {
    if (dragSize.value) return dragSize.value.width;
    return props.data.size?.width ?? DEFAULT_WIDTH;
});
const cardHeight = computed(() => {
    if (dragSize.value) return dragSize.value.height;
    if (props.data.size?.height != null) return props.data.size.height;
    // Resizable plugins need an explicit starting height so the card isn't
    // content-driven. Without it, text-size changes (e.g. the note plugin's
    // auto-fit) silently grow the card. Fall back to the manifest's minHeight.
    return resizable.value ? bounds.value.minHeight : undefined;
});
// The non-resizable floor: enough space for the declared ports.
const cardMinHeight = computed(
    () => 36 + Math.max(inputPorts.value.length, outputPorts.value.length, 1) * 24 + 8,
);

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

const { updateNodeInternals } = useVueFlow();

// When the stored size changes (e.g. patched from another browser), tell
// Vue Flow to re-measure so edge anchors follow.
watch(
    () => [props.data.size?.width, props.data.size?.height],
    () => updateNodeInternals([props.data.instanceId]),
);

function onResizeStart(event: MouseEvent | TouchEvent) {
    const startX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const startY = 'touches' in event ? event.touches[0].clientY : event.clientY;
    const startW = cardWidth.value;
    const startH = cardHeight.value ?? cardMinHeight.value;
    const b = bounds.value;

    const move = (e: MouseEvent | TouchEvent) => {
        const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
        dragSize.value = {
            width: clamp(startW + (cx - startX), b.minWidth!, b.maxWidth!),
            height: clamp(startH + (cy - startY), b.minHeight!, b.maxHeight!),
        };
        // Nudge Vue Flow so edge anchor points follow the resized node live.
        updateNodeInternals([props.data.instanceId]);
    };
    const end = () => {
        const final = dragSize.value;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', end);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', end);
        // patch.moduleSize applies optimistically (synchronous), so by the
        // time we clear `dragSize`, props.data.size already matches `final` —
        // cardWidth/cardHeight fall through to the stored size, no snap-back.
        if (final && engineId) patch.moduleSize(engineId, props.data.instanceId, final);
        dragSize.value = null;
        updateNodeInternals([props.data.instanceId]);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
}

/** Interpolate a status-line template: "{key}" replaced with statusData values. */
function interpolateFaceWidget(widget: Record<string, unknown>): string {
    const template = (widget.template as string) ?? '';
    const sectionId = (widget.section as string) ?? 'stats';
    const sectionData = props.data.statusData?.[sectionId] ?? {};
    return template.replace(/\{(\w+)\}/g, (_, key) => {
        const val = sectionData[key as string];
        return val !== undefined && val !== null ? String(val) : '—';
    });
}

/**
 * Read a text value from a module setting for `setting-text` face widgets.
 * Returns the `placeholder` from the widget definition when the setting is
 * empty, so the face shows something rather than blank space.
 */
function getSettingText(widget: Record<string, unknown>): string {
    const key = (widget.setting as string) ?? '';
    const raw = props.data.settings?.[key];
    const val = typeof raw === 'string' ? raw : '';
    if (val.trim().length > 0) return val;
    return (widget.placeholder as string) ?? '';
}

/** Get a numeric value from statusData for a meter widget. */
function getFaceWidgetValue(widget: Record<string, unknown>): number {
    const sectionId = (widget.section as string) ?? 'stats';
    const key = (widget.key as string) ?? '';
    const val = props.data.statusData?.[sectionId]?.[key];
    return typeof val === 'number' ? val : Number(val) || 0;
}

const hasStats = computed(() => allStatusSections.value.length > 0);

const inputPorts = computed(() => props.data.ports?.filter((p) => p.direction === 'input') ?? []);
const outputPorts = computed(() => props.data.ports?.filter((p) => p.direction === 'output') ?? []);

// Show VU meters if the module has any audio/pcm ports
const hasAudio = computed(
    () => props.data.ports?.some((p) => p.streamType === 'audio/pcm') ?? false,
);
// Read VU data from dedicated reactive store (updates at ~15Hz without triggering full re-render)
const vuChannels = computed(() => {
    const live = vuStore.get(engineId, props.data.instanceId);
    if (live && live.length > 0) return live;
    return [];
});

// Long-press for mobile context menu
const emit = defineEmits<{ longpress: [event: TouchEvent] }>();
let longPressTimer: ReturnType<typeof setTimeout> | null = null;

function onTouchStart(e: TouchEvent) {
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        emit('longpress', e);
    }, 500);
}
function onTouchEnd() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}
function onTouchMove() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

onUnmounted(() => {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
});

/**
 * Resolve a Lucide icon component by name.
 * Plugin specifies icon as kebab-case (e.g. "mic", "volume-2", "upload", "download").
 * Lucide exports as PascalCase (e.g. "Mic", "Volume2", "Upload", "Download").
 */
const iconComponent = computed(() => getLucideIcon(props.data.icon ?? ''));

const moduleColor = computed(() => props.data.color ?? undefined);

const healthColor = computed(() => {
    switch (props.data.health) {
        case 'ok':
            return 'var(--health-ok)';
        case 'warning':
            return 'var(--health-warning)';
        case 'error':
            return 'var(--health-error)';
        default:
            return 'var(--health-stopped)';
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
    if (typeof value === 'object') return JSON.stringify(value);
    const str = typeof value === 'number' ? value.toLocaleString() : String(value);
    return unit ? `${str} ${unit}` : str;
}
</script>

<template>
    <div
        class="rounded-lg shadow-md select-none relative bg-card transition-[opacity] duration-200 ease-in-out flex flex-col"
        @touchstart.passive="onTouchStart"
        @touchend.passive="onTouchEnd"
        @touchmove.passive="onTouchMove"
        :class="data.health === 'error' ? 'border-2 border-error' : 'border border-border'"
        :style="{
            borderLeft: moduleColor ? `3px solid ${moduleColor}` : undefined,
            width: cardWidth + 'px',
            minHeight: cardMinHeight + 'px',
            ...(resizable && cardHeight ? { height: cardHeight + 'px' } : {}),
            opacity: data.enabled === false ? 0.4 : isDimmed ? 0.15 : 1,
        }"
    >
        <!-- Resize grip (bottom-right) — only for opt-in plugins -->
        <div
            v-if="resizable"
            class="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize opacity-40 hover:opacity-100"
            style="z-index: 5"
            @mousedown.stop.prevent="onResizeStart"
            @touchstart.stop.prevent="onResizeStart"
            title="Drag to resize"
        >
            <svg viewBox="0 0 16 16" class="w-full h-full" fill="currentColor">
                <path
                    d="M11 15 L15 11 M7 15 L15 7 M3 15 L15 3"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    fill="none"
                />
            </svg>
        </div>
        <!-- Interlock membership badge -->
        <div
            v-if="interlock"
            class="absolute -top-2 left-2 px-1.5 py-0.5 rounded text-[9px] font-semibold flex items-center gap-1 border transition-colors"
            :class="isHotMember ? 'border-transparent' : 'bg-card border-border text-foreground'"
            :style="
                isHotMember
                    ? {
                          backgroundColor: interlock.color ?? INTERLOCK_DEFAULT_COLOR,
                          color: readableTextOn(interlock.color ?? INTERLOCK_DEFAULT_COLOR),
                      }
                    : undefined
            "
            :title="`Interlock: ${interlock.name}`"
        >
            <span
                v-if="!isHotMember"
                class="w-1.5 h-1.5 rounded-full"
                :style="{ backgroundColor: interlock.color ?? INTERLOCK_DEFAULT_COLOR }"
            />
            <span class="truncate max-w-[80px]">{{ interlock.name }}</span>
        </div>

        <!-- Header -->
        <div class="flex items-center gap-2 px-3 py-2 relative border-b border-border-alt">
            <!-- Plugin icon (Lucide) or fallback colored dot -->
            <component
                v-if="iconComponent"
                :is="iconComponent"
                :size="14"
                :color="moduleColor ?? 'var(--text-muted)'"
                class="shrink-0"
            />
            <div
                v-else
                class="w-3 h-3 rounded-full shrink-0"
                :style="{ backgroundColor: moduleColor ?? 'var(--text-muted)' }"
            />
            <span class="text-xs font-medium truncate flex-1 text-foreground">
                {{ data.displayName }}
            </span>
            <span
                v-if="data.pendingRestart"
                class="text-[10px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-400"
            >
                restart
            </span>
            <button
                v-if="hasStats"
                @click.stop="showStats = !showStats"
                class="w-4 h-4 flex items-center justify-center rounded shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                :class="showStats ? 'text-accent' : 'text-muted'"
                title="Stats"
            >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <rect x="0" y="5" width="2" height="5" />
                    <rect x="4" y="2" width="2" height="8" />
                    <rect x="8" y="0" width="2" height="10" />
                </svg>
            </button>
            <!-- Health indicator dot (top-right corner) with tooltip -->
            <div
                class="absolute top-1 right-1 w-[6px] h-[6px] rounded-full group cursor-help"
                :style="{ backgroundColor: healthColor }"
            >
                <div
                    class="hidden group-hover:block absolute right-0 top-3 w-36 p-2 rounded-md shadow-lg text-[9px] leading-relaxed bg-card border border-border"
                    style="z-index: 9999"
                >
                    <div class="flex items-center gap-1.5 mb-0.5">
                        <span
                            class="w-2 h-2 rounded-full inline-block"
                            style="background: #22c55e"
                        /><span class="text-foreground">Running</span>
                    </div>
                    <div class="flex items-center gap-1.5 mb-0.5">
                        <span
                            class="w-2 h-2 rounded-full inline-block"
                            style="background: #f59e0b"
                        /><span class="text-foreground">Warning</span>
                    </div>
                    <div class="flex items-center gap-1.5 mb-0.5">
                        <span
                            class="w-2 h-2 rounded-full inline-block"
                            style="background: #ef4444"
                        /><span class="text-foreground">Error</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span
                            class="w-2 h-2 rounded-full inline-block"
                            style="background: #6b7280"
                        /><span class="text-foreground">Stopped</span>
                    </div>
                    <div
                        v-if="data.error"
                        class="mt-1 pt-1 text-red-400 break-words whitespace-normal border-t border-border-alt"
                    >
                        {{ data.error }}
                    </div>
                </div>
            </div>
        </div>

        <!-- Stats modal (full overlay) -->
        <Teleport to="body">
            <div
                v-if="showStats && hasStats"
                class="fixed inset-0 flex items-center justify-center"
                style="z-index: 10000"
            >
                <div
                    class="absolute inset-0 bg-black/50 backdrop-blur-sm"
                    @click="showStats = false"
                />
                <div
                    class="relative w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl shadow-2xl mx-4 bg-card border border-border"
                >
                    <!-- Header -->
                    <div
                        class="flex items-center justify-between px-5 py-3 sticky top-0 bg-card border-b border-border-alt"
                    >
                        <div class="flex items-center gap-2">
                            <component
                                v-if="iconComponent"
                                :is="iconComponent"
                                :size="18"
                                :color="moduleColor ?? 'var(--text-muted)'"
                            />
                            <h2 class="text-sm font-semibold text-foreground">
                                {{ data.displayName }} — Stats
                            </h2>
                        </div>
                        <button
                            @click="showStats = false"
                            class="p-1 rounded-md hover:bg-white/10 text-muted"
                        >
                            <svg
                                class="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M6 18L18 6M6 6l12 12"
                                />
                            </svg>
                        </button>
                    </div>
                    <!-- Sections (static from manifest + dynamic from runtime) -->
                    <div class="p-5 space-y-4">
                        <div v-for="section in allStatusSections" :key="section.id">
                            <h3
                                class="text-xs font-semibold uppercase tracking-wide mb-2 text-muted"
                            >
                                {{ section.label }}
                            </h3>
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                                <template v-for="field in section.fields" :key="field.key">
                                    <span class="text-xs text-muted">{{ field.label }}</span>
                                    <span class="text-xs tabular-nums text-right text-foreground">
                                        {{
                                            formatStatusValue(
                                                data.statusData?.[section.id]?.[field.key],
                                                field.unit,
                                            )
                                        }}
                                    </span>
                                </template>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Teleport>

        <!-- Badges -->
        <div v-if="moduleBadges.length > 0" class="px-3 py-0.5 flex flex-wrap gap-1">
            <span
                v-for="badge in moduleBadges"
                :key="badge.id"
                class="inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-surface-alt"
                :style="{ color: badge.color ?? 'var(--text-muted)' }"
            >
                <component
                    v-if="badge.icon && getLucideIcon(badge.icon)"
                    :is="getLucideIcon(badge.icon)"
                    :size="9"
                />
                <span>{{ badge.text }}</span>
            </span>
        </div>

        <!-- Plugin-provided face component (rich view, full Vue power) -->
        <!-- Plugin face: fills remaining card height. The `min-h-0 overflow-hidden`
             combo is what makes `flex: 1` actually cap the inner content so any
             auto-fit script inside the plugin sees a bounded container. -->
        <div v-if="pluginFace" class="flex-1 min-h-0 overflow-hidden flex flex-col">
            <component :is="pluginFace" :module="data" />
        </div>

        <!-- Face widgets (declarative from manifest) -->
        <div v-if="faceWidgets.length > 0" class="px-3 space-y-0.5">
            <template v-for="widget in faceWidgets" :key="widget.id">
                <!-- Status line: interpolated text from statusData -->
                <div
                    v-if="widget.type === 'status-line'"
                    class="text-[9px] truncate"
                    :style="{ color: (widget.color as string) ?? 'var(--text-muted)' }"
                >
                    {{ interpolateFaceWidget(widget) }}
                </div>
                <!-- Meter: horizontal progress bar from statusData -->
                <div
                    v-else-if="widget.type === 'meter'"
                    class="h-1.5 rounded-full overflow-hidden bg-surface-alt"
                >
                    <div
                        class="h-full rounded-full transition-all duration-300"
                        :style="{
                            width: Math.min(100, Math.max(0, getFaceWidgetValue(widget))) + '%',
                            backgroundColor: (widget.color as string) ?? 'var(--accent)',
                        }"
                    />
                </div>
                <!-- Setting text: multi-line text read directly from a setting key.
                     Intentionally NOT truncated — the whole note should be visible. -->
                <div
                    v-else-if="widget.type === 'setting-text'"
                    class="text-[11px] leading-snug whitespace-pre-wrap break-words"
                    :class="getSettingText(widget) ? 'text-foreground' : 'text-muted italic'"
                >
                    {{ getSettingText(widget) }}
                </div>
            </template>
        </div>

        <!-- Port labels -->
        <div class="px-3 py-1 flex justify-between">
            <div class="space-y-1">
                <div v-for="port in inputPorts" :key="port.id" class="h-5 flex items-center">
                    <span
                        v-if="(port.maxConnections ?? -1) === -1"
                        class="text-[8px] opacity-40 mr-0.5"
                        >&#8734;</span
                    >
                    <span class="text-[10px] pl-2 text-muted">{{ port.label || port.id }}</span>
                </div>
            </div>
            <div class="space-y-1">
                <div
                    v-for="port in outputPorts"
                    :key="port.id"
                    class="h-5 flex items-center justify-end"
                >
                    <span class="text-[10px] pr-2 text-muted">{{ port.label || port.id }}</span>
                    <span
                        v-if="(port.maxConnections ?? -1) === -1"
                        class="text-[8px] opacity-40 ml-0.5"
                        >&#8734;</span
                    >
                </div>
            </div>
        </div>

        <!-- VU Meter (canvas — always visible for audio modules) -->
        <div v-if="hasAudio" class="px-3 py-1 h-4">
            <MrVuMeter :levels="vuChannels" orientation="horizontal" />
        </div>

        <!-- Error -->
        <div
            v-if="data.error && data.health === 'error'"
            class="group/err relative px-3 py-1 text-[10px] text-red-400 break-words whitespace-normal"
        >
            {{ data.error }}
            <div
                class="hidden group-hover/err:block absolute left-0 top-full mt-1 p-2 rounded-md shadow-lg text-[10px] leading-relaxed pointer-events-none bg-card border border-border text-foreground w-64 z-50"
            >
                {{ data.error }}
            </div>
        </div>

        <!-- Input handles (left) — hidden if maxConnections=0 -->
        <Handle
            v-for="(port, i) in inputPorts"
            :key="'in-' + port.id"
            :id="port.id"
            type="target"
            :position="Position.Left"
            v-show="(port.maxConnections ?? -1) !== 0"
            class="!w-3 !h-3 !rounded-full !border-2 !border-surface"
            :style="{
                top: 44 + i * 24 + 'px',
                backgroundColor: portColorMap[port.streamType] ?? '#6b7280',
            }"
        />

        <!-- Output handles (right) — hidden if maxConnections=0 -->
        <Handle
            v-for="(port, i) in outputPorts"
            :key="'out-' + port.id"
            :id="port.id"
            type="source"
            :position="Position.Right"
            v-show="(port.maxConnections ?? -1) !== 0"
            class="!w-3 !h-3 !rounded-full !border-2 !border-surface"
            :style="{
                top: 44 + i * 24 + 'px',
                backgroundColor: portColorMap[port.streamType] ?? '#6b7280',
            }"
        />
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    inject,
    ref,
    watch,
    nextTick,
    onMounted,
    onUnmounted,
    type Ref,
} from 'vue';
import { Handle, Position } from '@vue-flow/core';
import type { ModuleState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { useVuStore } from '@/stores/vuMeters';
import MrVuMeter from './MrVuMeter.vue';
import ModuleNodeStatsModal from './ModuleNodeStatsModal.vue';
import { getLucideIcon } from '@/composables/useLucideIcons';
import {
    getInterlockForModule,
    INTERLOCK_DEFAULT_COLOR,
    readableTextOn,
} from '@/composables/useInterlocks';
import { getFaceComponent } from '@/composables/usePluginFaceComponent';
import { patch } from '@/composables/usePatch';
import { useResizableCard } from '@/composables/useResizableCard';
import { useLongPress } from '@/composables/useLongPress';
import { upstreamPorts } from '@/utils/upstreamLabels';
import { codecChip, compactPortLabel } from '@/utils/portDisplay';

const props = defineProps<{ data: ModuleState }>();

const emit = defineEmits<{ longpress: [event: TouchEvent] }>();

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

// Merge static sections (from plugin manifest) with dynamic sections (from runtime)
const allStatusSections = computed(() => {
    const staticSections = props.data.statusSections ?? [];
    const dynamicSections = props.data.dynamicStatusSections ?? [];
    return [...staticSections, ...dynamicSections];
});

const moduleBadges = computed(() => props.data.badges ?? []);
const faceWidgets = computed(() => props.data.faceWidgets ?? []);

// --- Port handle alignment ---
// The connection dots are absolutely positioned, so their vertical offset must
// track the port-label rows — which shift DOWN when a stats badge (or a face
// widget) is shown above them. A fixed offset made the top dot ride up next to
// the badge, looking like it belonged to it. Instead we measure the port-row
// container's layout offset (offsetTop is layout-based, so it ignores the
// canvas zoom transform) and drop each dot at its row centre, re-measuring
// whenever the card body reflows. The fallback (30) keeps the first paint on
// the old baseline (30 + 14 = the previous 44px), so there's no flicker.
const portsEl = ref<HTMLElement | null>(null);
const portsOffsetTop = ref(30);
const ROW_STEP = 24; // h-5 row (20px) + space-y-1 gap (4px)
const ROW_CENTER = 14; // container py-1 (4px) + half row height (10px)
const handleTop = (i: number): string =>
    `${portsOffsetTop.value + ROW_CENTER + i * ROW_STEP}px`;

function measurePorts(): void {
    if (portsEl.value) portsOffsetTop.value = portsEl.value.offsetTop;
}

let resizeObs: ResizeObserver | null = null;
onMounted(() => {
    measurePorts();
    const parent = portsEl.value?.offsetParent;
    if (parent && typeof ResizeObserver !== 'undefined') {
        resizeObs = new ResizeObserver(() => measurePorts());
        resizeObs.observe(parent);
    }
});
onUnmounted(() => resizeObs?.disconnect());
// Badges / face widgets arrive via runtime state pushes — re-measure on change.
watch([moduleBadges, faceWidgets, () => props.data.ports], () => nextTick(measurePorts), {
    deep: true,
});

// Plugin-provided face component: if the plugin ships a `ui/NodeFace.vue`,
// it's rendered in the body of the card. Declarative widgets (`faceWidgets`)
// still work alongside for simpler cases.
const pluginFace = computed(() => getFaceComponent(props.data.pluginId));

/** Port ids of this module that have at least one edge attached. Driven by
 *  the engine store's connection list, so it tracks live wiring. */
const connectedPortIds = computed(() => {
    const conns = engineStore.getEngine(engineId)?.connections ?? [];
    const id = props.data.instanceId;
    const set = new Set<string>();
    for (const c of conns) {
        if (c.sourceModuleId === id) set.add(c.sourcePortId);
        if (c.sinkModuleId === id) set.add(c.sinkPortId);
    }
    return set;
});

/** `hideWhenUnconnected` ports are display-noise while nothing is wired to
 *  them (legacy positional ports after PID discovery). Connected ones always
 *  render — hiding is purely visual, the port stays registered engine-side. */
function isVisiblePort(p: { id: string; hideWhenUnconnected?: boolean }): boolean {
    return !p.hideWhenUnconnected || connectedPortIds.value.has(p.id);
}

const inputPorts = computed(
    () => props.data.ports?.filter((p) => p.direction === 'input').filter(isVisiblePort) ?? [],
);

/** Input-pin id → compact identity of the connected upstream port(s): one
 *  value by priority (in-band name → ISO language → decimal PID) plus a
 *  codec chip. Only ports carrying structured `streamInfo` are mirrored —
 *  the point is reflecting STREAM identity on the receiving pin; a plain
 *  role label ("MPEG-TS Out") adds nothing. */
const upstreamPins = computed(() => {
    const engine = engineStore.getEngine(engineId);
    const result = new Map<string, Array<{ text: string; chip: ReturnType<typeof codecChip> }>>();
    if (!engine) return result;
    const ports = upstreamPorts(engine.modules, engine.connections, props.data.instanceId);
    for (const [sinkPortId, srcPorts] of ports) {
        const items = srcPorts
            .filter((src) => src.streamInfo)
            .map((src) => ({ text: compactPortLabel(src), chip: codecChip(src) }));
        if (items.length) result.set(sinkPortId, items);
    }
    return result;
});

interface PinItem {
    text: string;
    chip: ReturnType<typeof codecChip>;
    /** Identity derived from the connected upstream port (accent-tinted). */
    mirrored?: boolean;
}

/** What an input pin displays — stream identity when available, by priority:
 *  the pin's OWN streamInfo (muxer stream entries) → the connected upstream
 *  port's identity → the plain role label. Same compact one-value form as
 *  output pins everywhere. */
function inputPinItems(port: (typeof inputPorts.value)[number]): PinItem[] {
    if (port.streamInfo) return [{ text: compactPortLabel(port), chip: codecChip(port) }];
    const mirrored = upstreamPins.value.get(port.id);
    if (mirrored?.length) return mirrored.map((m) => ({ ...m, mirrored: true }));
    return [{ text: port.label || port.id, chip: null }];
}
const outputPorts = computed(
    () => props.data.ports?.filter((p) => p.direction === 'output').filter(isVisiblePort) ?? [],
);

// Resizable card composable handles drag math + size persistence
const { resizable, cardWidth, cardHeight, cardMinHeight, onResizeStart } = useResizableCard({
    moduleId: computed(() => props.data.instanceId),
    resizable: computed(() => props.data.resizable),
    storedSize: computed(() => props.data.size),
    portCount: computed(() => Math.max(inputPorts.value.length, outputPorts.value.length)),
    onPersist: (size) => {
        if (engineId) patch.moduleSize(engineId, props.data.instanceId, size);
    },
});

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

// Show VU meters if the module has any audio ports (pcm or 302m PCM-in-TS)
const hasAudio = computed(
    () =>
        props.data.ports?.some(
            (p) => p.streamType === 'audio/pcm' || p.streamType === 'audio/302m',
        ) ?? false,
);
// Read VU data from dedicated reactive store (updates at ~15Hz without triggering full re-render)
const vuChannels = computed(() => {
    const live = vuStore.get(engineId, props.data.instanceId);
    if (live && live.length > 0) return live;
    return [];
});

// Long-press for mobile context menu
const { onTouchStart, onTouchEnd, onTouchMove } = useLongPress((e) => emit('longpress', e));

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
    'audio/302m': '#06b6d4',
    'audio/opus': 'var(--port-audio-pcm)',
    'audio/aac': 'var(--port-audio-pcm)',
    'muxed/mpegts': 'var(--port-muxed-mpegts)',
    'video/raw': 'var(--port-video-raw)',
    'video/h264': '#e74c3c',
    'video/h265': '#c0392b',
    'text/subtitle': '#9b59b6',
    'data/generic': '#7f8c8d',
};

/**
 * Handle fill. Solid by the port's stream type; a port that declares
 * `acceptsAnyTs` (an input that meaningfully consumes EITHER TS family —
 * e.g. the audio-transcoder decoding a muxed TS or a 302M stream) splits
 * half muxed-orange / half 302M-cyan. Plugin-declared — pure TS transport
 * pins (splitter, SRT/RIST outputs) stay solid even though TS-family
 * wiring compatibility applies to them too.
 */
function handleBackground(port: { streamType: string; acceptsAnyTs?: boolean }): string {
    if (port.acceptsAnyTs) {
        return `linear-gradient(180deg, ${portColorMap['muxed/mpegts']} 50%, ${portColorMap['audio/302m']} 50%)`;
    }
    return portColorMap[port.streamType] ?? '#6b7280';
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
        <ModuleNodeStatsModal
            v-model:open="showStats"
            :display-name="data.displayName"
            :icon-component="iconComponent"
            :icon-color="moduleColor"
            :sections="allStatusSections"
            :status-data="data.statusData"
        />

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

        <!-- Port labels. Every row is a single line (h-5) because the
             connection dots are absolutely positioned at fixed ROW_STEP
             offsets — a wrapping label bleeds over the neighbouring rows and
             detaches the text from its dot. Pins show ONE compact value
             (in-band name → ISO language → decimal PID; role label otherwise)
             plus a small codec chip; anything longer ellipsizes (min-w-0
             columns + truncate). Full detail lives in the stats modal. -->
        <div ref="portsEl" class="px-3 py-1 flex justify-between gap-2">
            <div class="space-y-1 min-w-0">
                <div v-for="port in inputPorts" :key="port.id" class="h-5 flex items-center min-w-0">
                    <span
                        v-if="(port.maxConnections ?? -1) === -1"
                        class="text-[8px] opacity-40 mr-0.5 shrink-0"
                        >&#8734;</span
                    >
                    <span class="pl-2 shrink-0" />
                    <!-- Stream identity when available (own config → mirrored
                         from the connected upstream port), else role label. -->
                    <template v-for="(item, i) in inputPinItems(port)" :key="`${port.id}-${i}`">
                        <span v-if="i > 0" class="text-[10px] mx-0.5 opacity-40 shrink-0">+</span>
                        <span
                            class="text-[10px] truncate"
                            :class="item.mirrored ? 'text-accent/80' : 'text-muted'"
                            >{{ item.text }}</span
                        >
                        <span
                            v-if="item.chip"
                            class="text-[8px] leading-none px-1 py-0.5 ml-0.5 rounded shrink-0"
                            :class="item.chip.classes"
                            >{{ item.chip.text }}</span
                        >
                    </template>
                </div>
            </div>
            <div class="space-y-1 min-w-0">
                <div
                    v-for="port in outputPorts"
                    :key="port.id"
                    class="h-5 flex items-center justify-end min-w-0"
                >
                    <span class="text-[10px] pr-1 text-muted truncate">{{
                        compactPortLabel(port)
                    }}</span>
                    <span
                        v-if="codecChip(port)"
                        class="text-[8px] leading-none px-1 py-0.5 mr-1 rounded shrink-0"
                        :class="codecChip(port)!.classes"
                        >{{ codecChip(port)!.text }}</span
                    >
                    <span
                        v-if="(port.maxConnections ?? -1) === -1"
                        class="text-[8px] opacity-40 ml-0.5 shrink-0"
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
                top: handleTop(i),
                background: handleBackground(port),
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
                top: handleTop(i),
                background: handleBackground(port),
            }"
        />
    </div>
</template>

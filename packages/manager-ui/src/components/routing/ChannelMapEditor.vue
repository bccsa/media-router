<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import { useEngineStore, type ChannelMapEntry } from '@/stores/engines';
import { patch } from '@/composables/usePatch';

const props = defineProps<{
    engineId: string;
    connectionId: string;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
}>();

const engineStore = useEngineStore();

// Look up connection and modules from store
const engine = computed(() => engineStore.getEngine(props.engineId));
const connection = computed(() =>
    engine.value?.connections.find((c) => c.id === props.connectionId) ?? null
);
const srcModule = computed(() => {
    const conn = connection.value;
    return conn ? engine.value?.modules[conn.sourceModuleId] ?? null : null;
});
const dstModule = computed(() => {
    const conn = connection.value;
    return conn ? engine.value?.modules[conn.sinkModuleId] ?? null : null;
});
const srcChannels = computed(() => (srcModule.value?.settings?.channels as number) ?? 2);
const dstChannels = computed(() => (dstModule.value?.settings?.channels as number) ?? 2);

// Local editable channel map
const mappings = ref<Array<{ srcChannel: number; dstChannel: number; gain: number }>>([]);

// Channel labels
const srcLabels = computed(() =>
    Array.from({ length: srcChannels.value }, (_, i) => `CH ${i + 1}`)
);
const dstLabels = computed(() =>
    Array.from({ length: dstChannels.value }, (_, i) => `CH ${i + 1}`)
);

/** Generate default mapping based on source/dest channel counts */
function generateDefaultMap(): Array<{ srcChannel: number; dstChannel: number; gain: number }> {
    const s = srcChannels.value;
    const d = dstChannels.value;

    if (s === 1 && d >= 2) {
        // Mono → Stereo: duplicate to all dest channels
        return Array.from({ length: d }, (_, i) => ({ srcChannel: 0, dstChannel: i, gain: 1.0 }));
    }
    if (s >= 2 && d === 1) {
        // Stereo+ → Mono: mix all down at equal gain
        return Array.from({ length: s }, (_, i) => ({
            srcChannel: i, dstChannel: 0, gain: Math.round((1.0 / s) * 100) / 100,
        }));
    }
    // Same or N→M: 1:1 for min(s,d) channels
    const minCh = Math.min(s, d);
    return Array.from({ length: minCh }, (_, i) => ({ srcChannel: i, dstChannel: i, gain: 1.0 }));
}

// Load existing channel map on mount, or generate default
onMounted(() => {
    if (connection.value?.channelMap?.length) {
        mappings.value = connection.value.channelMap.map((m) => ({
            srcChannel: m.srcChannel,
            dstChannel: m.dstChannel,
            gain: m.gain ?? 1.0,
        }));
    } else {
        mappings.value = generateDefaultMap();
    }
});

// --- SVG layout ---
const svgRef = ref<SVGSVGElement | null>(null);
const svgHeight = computed(() => Math.max(srcChannels.value, dstChannels.value) * 44 + 40);

function getSrcDotPos(ch: number) {
    return { x: 20, y: 40 + ch * 44 };
}
function getDstDotPos(ch: number) {
    return { x: 280, y: 40 + ch * 44 };
}

// --- Drag interaction ---
const dragging = ref<{ srcChannel: number; x: number; y: number } | null>(null);
const dragTarget = ref<number | null>(null);
let dragCleanup: (() => void) | null = null;

onUnmounted(() => { dragCleanup?.(); });

function clientToSvg(clientX: number, clientY: number): { x: number; y: number } {
    if (!svgRef.value) return { x: 0, y: 0 };
    const pt = svgRef.value.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svgRef.value.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const svgPt = pt.matrixTransform(ctm.inverse());
    return { x: svgPt.x, y: svgPt.y };
}

function startDrag(srcChannel: number, event: MouseEvent | TouchEvent) {
    event.preventDefault();
    const pos = getSrcDotPos(srcChannel);
    dragging.value = { srcChannel, x: pos.x, y: pos.y };

    const onMove = (e: MouseEvent | TouchEvent) => {
        if (!dragging.value || !svgRef.value) return;
        const clientX = 'clientX' in e ? e.clientX : e.touches[0].clientX;
        const clientY = 'clientY' in e ? e.clientY : e.touches[0].clientY;
        const svgPos = clientToSvg(clientX, clientY);
        dragging.value.x = svgPos.x;
        dragging.value.y = svgPos.y;

        dragTarget.value = null;
        for (let i = 0; i < dstChannels.value; i++) {
            const pos = getDstDotPos(i);
            const dx = dragging.value.x - pos.x;
            const dy = dragging.value.y - pos.y;
            if (Math.sqrt(dx * dx + dy * dy) < 20) {
                dragTarget.value = i;
                break;
            }
        }
    };

    const onUp = () => {
        if (dragging.value && dragTarget.value !== null) {
            addMapping(dragging.value.srcChannel, dragTarget.value);
        }
        dragging.value = null;
        dragTarget.value = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onUp);
        dragCleanup = null;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    dragCleanup = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onUp);
    };
}

// --- Mapping management ---
function addMapping(src: number, dst: number) {
    // Don't add duplicate
    if (mappings.value.some((m) => m.srcChannel === src && m.dstChannel === dst)) return;
    mappings.value = [...mappings.value, { srcChannel: src, dstChannel: dst, gain: 1.0 }];
}

function removeMapping(index: number) {
    mappings.value = mappings.value.filter((_, i) => i !== index);
}

// --- Context-aware presets ---
interface Preset { id: string; label: string; }

const availablePresets = computed<Preset[]>(() => {
    const s = srcChannels.value;
    const d = dstChannels.value;
    const presets: Preset[] = [];

    // Always available
    presets.push({ id: '1:1', label: '1:1' });

    if (s === 1 && d >= 2) {
        // Mono → Stereo+
        presets.push({ id: 'monoToStereo', label: 'Mono → Stereo' });
        presets.push({ id: 'monoToL', label: 'Mono → L only' });
        presets.push({ id: 'monoToR', label: 'Mono → R only' });
    } else if (s >= 2 && d === 1) {
        // Stereo+ → Mono
        presets.push({ id: 'mixdown', label: 'Mix Down' });
        presets.push({ id: 'pickL', label: 'L → Mono' });
        presets.push({ id: 'pickR', label: 'R → Mono' });
    } else if (s >= 2 && d >= 2) {
        // Stereo+ → Stereo+
        presets.push({ id: 'swapLR', label: 'Swap L/R' });
        presets.push({ id: 'monoL', label: 'L to both' });
        presets.push({ id: 'monoR', label: 'R to both' });
        presets.push({ id: 'mixdown', label: 'Mix → Mono' });
    }

    presets.push({ id: 'clear', label: 'Clear' });
    return presets;
});

function applyPreset(preset: string) {
    const s = srcChannels.value;
    const d = dstChannels.value;
    const minCh = Math.min(s, d);

    switch (preset) {
        case '1:1':
            mappings.value = Array.from({ length: minCh }, (_, i) => ({
                srcChannel: i, dstChannel: i, gain: 1.0,
            }));
            break;
        case 'monoToStereo':
            // Mono source → both dest channels
            mappings.value = Array.from({ length: d }, (_, i) => ({
                srcChannel: 0, dstChannel: i, gain: 1.0,
            }));
            break;
        case 'monoToL':
            mappings.value = [{ srcChannel: 0, dstChannel: 0, gain: 1.0 }];
            break;
        case 'monoToR':
            mappings.value = [{ srcChannel: 0, dstChannel: d > 1 ? 1 : 0, gain: 1.0 }];
            break;
        case 'mixdown':
            // All source channels → dest CH1, equal gain
            mappings.value = Array.from({ length: s }, (_, i) => ({
                srcChannel: i, dstChannel: 0, gain: Math.round((1.0 / s) * 100) / 100,
            }));
            break;
        case 'pickL':
            mappings.value = [{ srcChannel: 0, dstChannel: 0, gain: 1.0 }];
            break;
        case 'pickR':
            mappings.value = [{ srcChannel: s > 1 ? 1 : 0, dstChannel: 0, gain: 1.0 }];
            break;
        case 'swapLR':
            if (minCh >= 2) {
                mappings.value = [
                    { srcChannel: 0, dstChannel: 1, gain: 1.0 },
                    { srcChannel: 1, dstChannel: 0, gain: 1.0 },
                ];
            }
            break;
        case 'monoL':
            // Left channel to all dest channels
            mappings.value = Array.from({ length: d }, (_, i) => ({
                srcChannel: 0, dstChannel: i, gain: 1.0,
            }));
            break;
        case 'monoR':
            // Right channel to all dest channels
            mappings.value = Array.from({ length: d }, (_, i) => ({
                srcChannel: s > 1 ? 1 : 0, dstChannel: i, gain: 1.0,
            }));
            break;
        case 'clear':
            mappings.value = [];
            break;
    }
}

// --- Save ---
function save() {
    const map: ChannelMapEntry[] = mappings.value.map((m) => ({
        srcChannel: m.srcChannel,
        dstChannel: m.dstChannel,
        ...(m.gain !== 1.0 ? { gain: m.gain } : {}),
    }));
    patch.connectionField(props.engineId, props.connectionId, 'channelMap', map.length > 0 ? map : undefined);
    emit('close');
}
</script>

<template>
    <div class="fixed inset-0 z-[1000] flex items-center justify-center" @click.self="emit('close')">
        <div class="rounded-xl shadow-2xl overflow-hidden flex flex-col"
             :style="{
                 backgroundColor: 'var(--bg-card)',
                 border: '1px solid var(--border-primary)',
                 width: 'min(90vw, 520px)',
                 maxHeight: '90vh',
             }">
            <!-- Header -->
            <div class="flex items-center justify-between px-4 py-3"
                 :style="{ borderBottom: '1px solid var(--border-secondary)' }">
                <div class="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ color: 'var(--accent)' }">
                        <path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
                    </svg>
                    <span class="font-semibold text-sm" :style="{ color: 'var(--text-primary)' }">Channel Map</span>
                </div>
                <button @click="emit('close')" class="p-1 rounded" :style="{ color: 'var(--text-muted)' }">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>

            <!-- Source → Dest header -->
            <div class="flex items-center justify-between px-4 py-2 text-xs"
                 :style="{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }">
                <div class="flex items-center gap-1">
                    <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: srcModule?.color ?? '#3b82f6' }" />
                    {{ srcModule?.displayName ?? 'Source' }}
                    <span class="opacity-50">({{ srcChannels }}ch)</span>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="opacity-40"><path d="M5 12h14m-7-7 7 7-7 7"/></svg>
                <div class="flex items-center gap-1">
                    <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: dstModule?.color ?? '#10b981' }" />
                    {{ dstModule?.displayName ?? 'Destination' }}
                    <span class="opacity-50">({{ dstChannels }}ch)</span>
                </div>
            </div>

            <!-- Presets -->
            <div class="flex items-center gap-1 px-4 py-2 overflow-x-auto no-scrollbar"
                 :style="{ borderBottom: '1px solid var(--border-secondary)' }">
                <span class="text-[10px] shrink-0 mr-1" :style="{ color: 'var(--text-muted)' }">Presets:</span>
                <button v-for="p in availablePresets" :key="p.id"
                    @click="applyPreset(p.id)"
                    class="text-[10px] px-2 py-0.5 rounded shrink-0 transition-colors"
                    :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-secondary)' }">
                    {{ p.label }}
                </button>
            </div>

            <!-- Channel map SVG canvas -->
            <div class="flex-1 overflow-auto px-4 py-3">
                <svg ref="svgRef" :width="300" :height="svgHeight" class="w-full" :viewBox="`0 0 300 ${svgHeight}`">
                    <!-- Existing mapping lines -->
                    <line v-for="(m, i) in mappings" :key="`${m.srcChannel}-${m.dstChannel}-${i}`"
                          :x1="getSrcDotPos(m.srcChannel).x" :y1="getSrcDotPos(m.srcChannel).y"
                          :x2="getDstDotPos(m.dstChannel).x" :y2="getDstDotPos(m.dstChannel).y"
                          stroke="var(--accent)" stroke-width="2" stroke-opacity="0.7"
                          class="cursor-pointer" @click="removeMapping(i)" />

                    <!-- Drag line -->
                    <line v-if="dragging"
                          :x1="getSrcDotPos(dragging.srcChannel).x" :y1="getSrcDotPos(dragging.srcChannel).y"
                          :x2="dragging.x" :y2="dragging.y"
                          :stroke="dragTarget !== null ? 'var(--accent)' : 'var(--text-muted)'"
                          stroke-width="2" stroke-dasharray="4,4" />

                    <!-- Source channel dots + labels -->
                    <g v-for="ch in srcChannels" :key="`src-${ch}`">
                        <circle :cx="getSrcDotPos(ch - 1).x" :cy="getSrcDotPos(ch - 1).y"
                                r="8" fill="var(--bg-input)" stroke="var(--accent)" stroke-width="2"
                                class="cursor-grab"
                                @mousedown="startDrag(ch - 1, $event)"
                                @touchstart="startDrag(ch - 1, $event)" />
                        <text :x="getSrcDotPos(ch - 1).x + 16" :y="getSrcDotPos(ch - 1).y + 4"
                              fill="var(--text-secondary)" font-size="11">{{ srcLabels[ch - 1] }}</text>
                    </g>

                    <!-- Dest channel dots + labels -->
                    <g v-for="ch in dstChannels" :key="`dst-${ch}`">
                        <circle :cx="getDstDotPos(ch - 1).x" :cy="getDstDotPos(ch - 1).y"
                                r="8"
                                :fill="dragTarget === ch - 1 ? 'var(--accent)' : 'var(--bg-input)'"
                                stroke="var(--accent)" stroke-width="2" />
                        <text :x="getDstDotPos(ch - 1).x - 16" :y="getDstDotPos(ch - 1).y + 4"
                              fill="var(--text-secondary)" font-size="11" text-anchor="end">{{ dstLabels[ch - 1] }}</text>
                    </g>
                </svg>
            </div>

            <!-- Mappings list -->
            <div v-if="mappings.length > 0" class="px-4 pb-2 max-h-32 overflow-auto"
                 :style="{ borderTop: '1px solid var(--border-secondary)' }">
                <div class="text-[10px] font-semibold uppercase tracking-wider py-1" :style="{ color: 'var(--text-muted)' }">
                    Mappings ({{ mappings.length }})
                </div>
                <div v-for="(m, i) in mappings" :key="`map-${m.srcChannel}-${m.dstChannel}`"
                     class="flex items-center gap-2 py-0.5 text-xs" :style="{ color: 'var(--text-secondary)' }">
                    <span class="w-12 shrink-0">{{ srcLabels[m.srcChannel] }}</span>
                    <span class="opacity-40">→</span>
                    <span class="flex-1">{{ dstLabels[m.dstChannel] }}</span>
                    <button @click="removeMapping(i)" class="p-0.5 rounded opacity-50 hover:opacity-100"
                            :style="{ color: 'var(--health-error)' }">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
            </div>

            <!-- Footer -->
            <div class="flex items-center justify-between px-4 py-3"
                 :style="{ borderTop: '1px solid var(--border-secondary)' }">
                <span class="text-[10px]" :style="{ color: 'var(--text-muted)' }">
                    Drag source → dest to map. Click line to remove.
                </span>
                <div class="flex gap-2">
                    <MrButton size="sm" variant="secondary" @click="emit('close')">Cancel</MrButton>
                    <MrButton size="sm" @click="save">Apply</MrButton>
                </div>
            </div>
        </div>
    </div>
</template>

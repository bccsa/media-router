<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { LcpModuleState } from '@/stores/modules';
import { useVuStore } from '@/stores/vuMeters';
import MrVuMeter from './MrVuMeter.vue';
import VerticalFader from './VerticalFader.vue';

const props = defineProps<{
    module: LcpModuleState;
}>();

const emit = defineEmits<{
    volume: [moduleId: string, volume: number];
    mute: [moduleId: string, muted: boolean];
}>();

const vuStore = useVuStore();

const vuLevels = computed(() => vuStore.get(props.module.instanceId));
const storeVolume = computed(() => (props.module.settings?.volume as number) ?? 100);
const volumeMax = computed(() => (props.module.settings?.volumeMax as number) ?? 150);
const volumeEnabled = computed(() => props.module.settings?.lcpVolumeEnabled !== false);
const muteEnabled = computed(() => props.module.settings?.lcpMuteEnabled !== false);
const isMuted = computed(() => props.module.settings?.audioEnabled === false);

// Local volume tracks the fader during drag — prevents snap-back between throttled emits
const localVolume = ref(storeVolume.value);
const dragging = ref(false);

// Sync from store when NOT dragging (e.g. another LCP client changed it)
watch(storeVolume, (v) => { if (!dragging.value) localVolume.value = v; });

const healthClass = computed(() => {
    switch (props.module.health) {
        case 'ok': return 'bg-ok';
        case 'warning': return 'bg-warning';
        case 'error': return 'bg-error';
        default: return 'bg-stopped';
    }
});

let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: number | null = null;

function onFaderInput(val: number) {
    localVolume.value = val;
    dragging.value = true;
    pendingValue = val;
    if (!throttleTimer) {
        emit('volume', props.module.instanceId, val);
        throttleTimer = setTimeout(() => {
            throttleTimer = null;
            if (pendingValue !== null) {
                emit('volume', props.module.instanceId, pendingValue);
                pendingValue = null;
            }
        }, 100);
    }
}

function onFaderEnd(val: number) {
    localVolume.value = val;
    dragging.value = false;
    emit('volume', props.module.instanceId, val);
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    pendingValue = null;
}

function toggleMute() {
    emit('mute', props.module.instanceId, !isMuted.value);
}
</script>

<template>
    <div class="mixer-strip">
        <!-- Module name + health dot -->
        <div class="strip-header">
            <div class="health-dot" :class="healthClass"></div>
            <div class="module-name">{{ module.displayName }}</div>
        </div>

        <!-- VU Meter (vertical) -->
        <div class="vu-container" :style="{ width: Math.min(Math.max(vuLevels.length, 2) * 10, 110) + 'px' }">
            <MrVuMeter :levels="vuLevels" orientation="vertical" :num-blocks="15" :block-gap="2" />
        </div>

        <!-- Volume fader -->
        <div v-if="volumeEnabled" class="fader-container">
            <VerticalFader
                :value="localVolume"
                :min="0"
                :max="volumeMax"
                @input="onFaderInput"
                @end="onFaderEnd"
            />
        </div>

        <!-- Volume display -->
        <div v-if="volumeEnabled" class="volume-display">{{ Math.round(localVolume) }}%</div>

        <!-- Mute button -->
        <button
            class="mute-btn"
            :class="{ muted: isMuted, disabled: !muteEnabled }"
            :disabled="!muteEnabled"
            @click="toggleMute"
        >
            {{ isMuted ? 'MUTED' : 'MUTE' }}
        </button>
    </div>
</template>

<style scoped>
.mixer-strip {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 120px;
    flex-shrink: 0;
    height: 100%;
    padding: 8px 4px;
    background: var(--bg-card, #232735);
    border-radius: 8px;
    border: 1px solid var(--border-primary, #2d3348);
    gap: 4px;
}

.strip-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0 4px;
    min-height: 24px;
}

.health-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
}

.module-name {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    width: 100%;
}

.vu-container {
    flex: 0 0 auto;
    height: 120px;
    align-self: center;
}

.fader-container {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100px;
    width: 100%;
}

.volume-display {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #f1f5f9);
    text-align: center;
    min-height: 20px;
}

.mute-btn {
    width: 100%;
    min-height: 48px;
    padding: 12px 4px;
    border: 1px solid var(--border-primary, #2d3348);
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.05em;
    cursor: pointer;
    background: transparent;
    color: var(--text-secondary, #94a3b8);
    transition: all 0.15s;
    touch-action: manipulation;
}

.mute-btn:active {
    transform: scale(0.95);
}

.mute-btn.muted {
    background: #ef4444;
    color: white;
    border-color: #ef4444;
}

.mute-btn.disabled {
    opacity: 0.3;
    cursor: not-allowed;
}

/* Landscape: shorter strips, smaller VU, compact layout */
@media (orientation: landscape) and (max-height: 500px) {
    .mixer-strip {
        padding: 4px 4px;
        gap: 2px;
    }
    .vu-container {
        height: 60px;
    }
    .fader-container {
        min-height: 60px;
    }
    .volume-display {
        font-size: 11px;
    }
    .mute-btn {
        min-height: 40px;
        padding: 8px 4px;
        font-size: 11px;
    }
}

/* Tablet landscape: more breathing room */
@media (orientation: landscape) and (min-height: 501px) {
    .vu-container {
        height: 100px;
    }
}

/* Portrait on small screens: narrower strips */
@media (orientation: portrait) and (max-width: 500px) {
    .mixer-strip {
        width: 100px;
    }
}
</style>

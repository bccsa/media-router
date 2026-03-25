<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LcpModuleState } from '@/stores/modules';
import { useVuStore } from '@/stores/vuMeters';
import MrVuMeter from './MrVuMeter.vue';

const props = defineProps<{
    module: LcpModuleState;
}>();

const emit = defineEmits<{
    volume: [moduleId: string, volume: number];
    mute: [moduleId: string, muted: boolean];
}>();

const vuStore = useVuStore();

const vuLevels = computed(() => vuStore.get(props.module.instanceId));
const volume = computed(() => (props.module.settings?.volume as number) ?? 100);
const volumeMax = computed(() => (props.module.settings?.volumeMax as number) ?? 150);
const volumeEnabled = computed(() => props.module.settings?.lcpVolumeEnabled !== false);
const muteEnabled = computed(() => props.module.settings?.lcpMuteEnabled !== false);
const isMuted = computed(() => props.module.settings?.audioEnabled === false);

const healthColor = computed(() => {
    switch (props.module.health) {
        case 'ok': return '#10b981';
        case 'warning': return '#f59e0b';
        case 'error': return '#ef4444';
        default: return '#6b7280';
    }
});

// Fader: throttled emit, no local state tracking
let throttleTimer: ReturnType<typeof setTimeout> | null = null;

function onFaderInput(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    if (!throttleTimer) {
        throttleTimer = setTimeout(() => {
            throttleTimer = null;
        }, 50);
        emit('volume', props.module.instanceId, val);
    }
}

function onFaderEnd(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    emit('volume', props.module.instanceId, val);
}

function toggleMute() {
    emit('mute', props.module.instanceId, !isMuted.value);
}
</script>

<template>
    <div class="mixer-strip">
        <!-- Module name + health dot -->
        <div class="strip-header">
            <div class="health-dot" :style="{ backgroundColor: healthColor }"></div>
            <div class="module-name">{{ module.displayName }}</div>
        </div>

        <!-- VU Meter (vertical) -->
        <div class="vu-container">
            <MrVuMeter :levels="vuLevels" orientation="vertical" :num-blocks="15" :block-gap="2" />
        </div>

        <!-- Volume fader (vertical) -->
        <div v-if="volumeEnabled" class="fader-container">
            <input
                type="range"
                class="vertical-fader"
                :min="0"
                :max="volumeMax"
                :value="volume"
                @input="onFaderInput"
                @mouseup="onFaderEnd"
                @touchend="onFaderEnd"
            />
        </div>

        <!-- Volume display -->
        <div v-if="volumeEnabled" class="volume-display">{{ Math.round(volume) }}%</div>

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
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary, #f1f5f9);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vu-container {
    flex: 0 0 auto;
    height: 120px;
    width: 100%;
    display: flex;
    justify-content: center;
}

.fader-container {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100px;
    width: 100%;
}

.vertical-fader {
    writing-mode: vertical-lr;
    direction: rtl;
    appearance: slider-vertical;
    width: 44px;
    height: 100%;
    cursor: pointer;
    accent-color: var(--accent, #10b981);
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
    padding: 8px 4px;
    border: 1px solid var(--border-primary, #2d3348);
    border-radius: 6px;
    font-size: 11px;
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
</style>

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

const localVolume = ref(storeVolume.value);
const dragging = ref(false);

watch(storeVolume, (v) => {
    if (!dragging.value) localVolume.value = v;
});

const healthClass = computed(() => {
    switch (props.module.health) {
        case 'ok':
            return 'ok';
        case 'warning':
            return 'warning';
        case 'error':
            return 'error';
        default:
            return 'stopped';
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
    if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
    }
    pendingValue = null;
}

function toggleMute() {
    emit('mute', props.module.instanceId, !isMuted.value);
}
</script>

<template>
    <div class="mixer-strip">
        <div class="strip-header">
            <div class="health-dot" :class="healthClass" />
            <div class="module-name">{{ module.displayName }}</div>
        </div>

        <div
            class="vu-container"
            :style="{ width: Math.min(Math.max(vuLevels.length, 2) * 10, 110) + 'px' }"
        >
            <MrVuMeter :levels="vuLevels" orientation="vertical" :num-blocks="15" :block-gap="2" />
        </div>

        <div v-if="volumeEnabled" class="fader-container">
            <VerticalFader
                :value="localVolume"
                :min="0"
                :max="volumeMax"
                @input="onFaderInput"
                @end="onFaderEnd"
            />
        </div>

        <div v-if="volumeEnabled" class="volume-display">{{ Math.round(localVolume) }}%</div>

        <button
            class="power-btn"
            :class="{ on: !isMuted, off: isMuted, disabled: !muteEnabled }"
            :disabled="!muteEnabled"
            @click="toggleMute"
        >
            {{ isMuted ? 'OFF' : 'ON' }}
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
    background: var(--text-muted);
}
.health-dot.ok { background: var(--health-ok); }
.health-dot.warning { background: var(--health-warning); }
.health-dot.error { background: var(--health-error); }

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

.power-btn {
    width: 100px;
    height: 64px;
    padding: 0;
    align-self: center;
    flex-shrink: 0;
    border: 1px solid var(--border-primary, #2d3348);
    border-radius: 8px;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.05em;
    cursor: pointer;
    transition: all 0.15s;
    touch-action: manipulation;
    background: transparent;
    color: var(--text-muted, #6b7280);
    opacity: 0.6;
}
.power-btn:active {
    transform: scale(0.95);
}
.power-btn.on {
    background: var(--accent, #10b981);
    color: #ffffff;
    border-color: var(--accent, #10b981);
    box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
    opacity: 1;
}
.power-btn.disabled {
    opacity: 0.3;
    cursor: not-allowed;
    box-shadow: none;
}

/* Small landscape (Pi 4 800×480): scale down in step. */
@media (orientation: landscape) and (max-height: 500px) {
    .mixer-strip { width: 96px; padding: 4px; gap: 2px; }
    .strip-header { min-height: 18px; }
    .module-name { font-size: 14px; }
    .vu-container { height: 60px; }
    .fader-container { min-height: 60px; }
    .volume-display { font-size: 11px; }
    .power-btn { width: 72px; height: 44px; font-size: 12px; }
}

/* Tablet landscape */
@media (orientation: landscape) and (min-height: 501px) {
    .vu-container { height: 100px; }
}

/* Narrow portrait */
@media (orientation: portrait) and (max-width: 500px) {
    .mixer-strip { width: 100px; }
}
</style>

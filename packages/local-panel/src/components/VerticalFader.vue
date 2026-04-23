<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';

const props = defineProps<{
    value: number;
    min?: number;
    max?: number;
}>();

const emit = defineEmits<{
    input: [value: number];
    end: [value: number];
}>();

const min = computed(() => props.min ?? 0);
const max = computed(() => props.max ?? 150);

const trackRef = ref<HTMLElement | null>(null);
const dragging = ref(false);

function valueToPercent(val: number): number {
    return ((val - min.value) / (max.value - min.value)) * 100;
}

function percentToValue(pct: number): number {
    const clamped = Math.max(0, Math.min(100, pct));
    return Math.round(min.value + (clamped / 100) * (max.value - min.value));
}

function getPercentFromY(clientY: number): number {
    if (!trackRef.value) return 0;
    const rect = trackRef.value.getBoundingClientRect();
    const pct = ((rect.bottom - clientY) / rect.height) * 100;
    return pct;
}

function onTouchStart(e: TouchEvent) {
    e.preventDefault();
    dragging.value = true;
    const pct = getPercentFromY(e.touches[0].clientY);
    emit('input', percentToValue(pct));
}

function onTouchMove(e: TouchEvent) {
    if (!dragging.value) return;
    e.preventDefault();
    const pct = getPercentFromY(e.touches[0].clientY);
    emit('input', percentToValue(pct));
}

function onTouchEnd(e: TouchEvent) {
    if (!dragging.value) return;
    dragging.value = false;
    const touch = e.changedTouches[0];
    const pct = getPercentFromY(touch.clientY);
    emit('end', percentToValue(pct));
}

function onMouseDown(e: MouseEvent) {
    e.preventDefault();
    dragging.value = true;
    const pct = getPercentFromY(e.clientY);
    emit('input', percentToValue(pct));
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
    if (!dragging.value) return;
    const pct = getPercentFromY(e.clientY);
    emit('input', percentToValue(pct));
}

function onMouseUp(e: MouseEvent) {
    dragging.value = false;
    const pct = getPercentFromY(e.clientY);
    emit('end', percentToValue(pct));
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
}

onUnmounted(() => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
});

const thumbPercent = computed(() => valueToPercent(props.value));
</script>

<template>
    <div
        ref="trackRef"
        class="fader-track"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @mousedown="onMouseDown"
    >
        <div class="fader-fill" :style="{ height: thumbPercent + '%' }"></div>
        <div class="fader-thumb" :style="{ bottom: thumbPercent + '%' }"></div>
    </div>
</template>

<style scoped>
/* Track interaction zone is wider than the visual track line — taps anywhere
 * inside this zone count as fader input. Makes the thumb easier to hit on
 * touchscreens without enlarging it. */
.fader-track {
    position: relative;
    width: 96px;
    height: 100%;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
}

/* Visual track line */
.fader-track::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 6px;
    margin-left: -3px;
    border-radius: 3px;
    background: var(--border-primary, #2d3348);
}

.fader-fill {
    position: absolute;
    left: 50%;
    bottom: 0;
    width: 6px;
    margin-left: -3px;
    border-radius: 3px;
    background: var(--accent, #10b981);
    pointer-events: none;
}

/* Thumb scales with viewport width so it stays thumb-sized across 7" Pi
 * touches up to 10"+ tablets. clamp caps at 56px so we don't get absurd
 * targets on ultra-wide screens, and floors at 36px so tiny portrait
 * windows still have a pressable target. */
.fader-thumb {
    --thumb-size: clamp(36px, 8vw, 56px);
    position: absolute;
    left: 50%;
    width: var(--thumb-size);
    height: var(--thumb-size);
    margin-left: calc(var(--thumb-size) / -2);
    margin-bottom: calc(var(--thumb-size) / -2);
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid rgba(255, 255, 255, 0.2);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    pointer-events: none;
}

/* Small landscape (Pi 4 800×480): narrow the track line; thumb already
 * shrinks via clamp. */
@media (orientation: landscape) and (max-height: 500px) {
    .fader-track {
        width: 72px;
    }
}
</style>

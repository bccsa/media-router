<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';

const props = defineProps<WidgetProps>();
const emit = defineEmits<{ write: [value: boolean] }>();

const on = computed(() => props.value === true);
const colour = computed(() => (on.value ? props.options.onColor || 'var(--d-accent)' : props.options.offColor || 'var(--d-stopped)'));
const text = computed(() => (on.value ? props.options.onText : props.options.offText));

function flip() {
    if (props.interactive) emit('write', !on.value);
}
</script>

<template>
    <button type="button" role="switch" class="tg" :class="{ 'tg-live': interactive }" :aria-checked="on" :aria-label="label" :disabled="!interactive" @click="flip">
        <div class="dw-label">{{ label }}</div>
        <div class="tg-row">
            <div class="tg-pill" :style="{ background: colour }">
                <div class="tg-knob" :class="{ 'tg-on': on }" />
            </div>
            <div v-if="text" class="tg-text dw-value">{{ text }}</div>
        </div>
    </button>
</template>

<style scoped>
.tg {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
}
.tg:focus-visible {
    outline: 2px solid var(--d-accent);
    outline-offset: -2px;
    border-radius: 6px;
}
.tg-live {
    cursor: pointer;
}
.tg-row {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 4px 8px 6px;
}
.tg-pill {
    position: relative;
    flex: none;
    width: clamp(36px, 30cqw, 72px);
    aspect-ratio: 1.8;
    border-radius: 999px;
    transition: background 0.15s;
}
.tg-knob {
    position: absolute;
    top: 10%;
    left: 6%;
    height: 80%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: var(--d-on-fill);
    transition: left 0.15s;
}
.tg-knob.tg-on {
    left: calc(94% - 44%);
}
.tg-text {
    font-size: clamp(11px, 22cqh, 22px);
}
</style>

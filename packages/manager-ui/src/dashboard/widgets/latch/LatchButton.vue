<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';

const props = defineProps<WidgetProps>();
const emit = defineEmits<{ write: [value: boolean] }>();

const lit = computed(() => (props.value === true) === (props.options.litWhen !== 'false'));
const colour = computed(() => props.options.litColor || 'var(--d-error)');
const text = computed(() => (lit.value ? props.options.litText : props.options.unlitText) || props.label);

function press() {
    if (props.interactive) emit('write', props.value !== true);
}
</script>

<template>
    <button
        class="tb"
        :class="{ 'tb-lit': lit }"
        :disabled="!interactive"
        :aria-pressed="value === true"
        :aria-label="label"
        :style="lit ? { background: colour, borderColor: colour } : {}"
        @click="press"
    >
        <span class="tb-text dw-value">{{ text }}</span>
    </button>
</template>

<style scoped>
.tb {
    width: 100%;
    height: 100%;
    border: 2px solid var(--d-border);
    border-radius: 7px;
    background: var(--d-track);
    color: var(--d-muted);
    font-weight: var(--dw-label-weight, 700);
    font-size: var(--dw-label-size, clamp(11px, 24cqh, 24px));
    letter-spacing: 0.03em;
    cursor: pointer;
    padding: 0 8px;
    transition: background 0.1s, color 0.1s;
}
.tb-lit {
    color: var(--d-on-fill);
}
.tb:not(:disabled):active {
    filter: brightness(1.3);
}
.tb:disabled {
    cursor: default;
}
.tb-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';

const props = defineProps<WidgetProps>();

const TEXT: Record<string, string> = { ok: 'OK', warning: 'Warning', error: 'Error', stopped: 'Stopped', true: 'On', false: 'Off' };

/** Health values map to themselves; true is ok, false is stopped. */
const state = computed(() => {
    if (props.value === true) return 'ok';
    if (props.value === false) return 'stopped';
    return typeof props.value === 'string' ? props.value : 'stopped';
});
const colour = computed(() => props.options[`${state.value}Color`] || `var(--d-${state.value in TEXT ? state.value : 'stopped'})`);
const text = computed(() => (typeof props.value === 'boolean' ? TEXT[String(props.value)] : (TEXT[state.value] ?? state.value)));
</script>

<template>
    <div class="sl">
        <div class="dw-label">{{ label }}</div>
        <div class="sl-row">
            <div class="sl-lamp" :style="{ background: colour, boxShadow: `0 0 12px ${colour}` }" />
            <div v-if="options.showText" class="sl-text dw-value">{{ text }}</div>
        </div>
    </div>
</template>

<style scoped>
.sl {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.sl-row {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 2px 8px 6px;
}
.sl-lamp {
    flex: none;
    width: clamp(12px, min(46cqh, 30cqw), 56px);
    aspect-ratio: 1;
    border-radius: 50%;
}
.sl-text {
    font-size: clamp(11px, 24cqh, 22px);
}
</style>

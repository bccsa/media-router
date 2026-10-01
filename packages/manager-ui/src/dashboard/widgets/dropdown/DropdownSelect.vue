<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';

const props = defineProps<WidgetProps>();
const emit = defineEmits<{ write: [value: unknown] }>();

const choices = computed(() =>
    (props.desc?.enum ?? []).map((v) => ({ v, label: props.desc?.enumLabels?.[String(v)] ?? String(v) })),
);
const index = computed(() => choices.value.findIndex((c) => String(c.v) === String(props.value)));

function pick(e: Event) {
    const i = Number((e.target as HTMLSelectElement).value);
    if (props.interactive && choices.value[i]) emit('write', choices.value[i].v);
}
</script>

<template>
    <div class="dd">
        <div class="dw-label">{{ label }}</div>
        <div class="dd-row">
            <select class="dd-select" :aria-label="label" :disabled="!interactive" :value="index" @change="pick">
                <option v-if="index < 0" :value="-1" disabled>{{ value === undefined ? '—' : String(value) }}</option>
                <option v-for="(c, i) in choices" :key="i" :value="i">{{ c.label }}</option>
            </select>
        </div>
    </div>
</template>

<style scoped>
.dd {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.dd-row {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    padding: 4px 6px 6px;
}
.dd-select {
    width: 100%;
    height: min(100%, 44px);
    border-radius: 6px;
    border: 1px solid var(--d-border);
    background: var(--d-bg);
    color: var(--d-text);
    font-size: clamp(11px, 20cqh, 18px);
    padding: 0 6px;
}
.dd-select:disabled {
    opacity: 0.7;
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';
import { fraction } from '../../drag';
import { asNumber, formatValue, stepDecimals } from '../../valueTypes';

const props = defineProps<WidgetProps>();

const vertical = computed(() => props.widget.h > props.widget.w);
const num = computed(() => asNumber(props.value));
const frac = computed(() => (num.value === undefined ? 0 : fraction(num.value, props.desc?.min ?? 0, props.desc?.max ?? 100)));
const text = computed(() =>
    formatValue(num.value, stepDecimals(Number(props.options.step) || props.desc?.step), props.options.showUnit ? props.desc?.unit : undefined),
);
const accent = computed(() => props.options.accent || 'var(--d-accent)');
</script>

<template>
    <div class="bg" :class="vertical ? 'bg-v' : 'bg-h'">
        <div class="dw-label">{{ label }}</div>
        <div class="bg-area">
            <div class="bg-track">
                <div class="bg-fill" :style="vertical ? { height: `${frac * 100}%`, background: accent } : { width: `${frac * 100}%`, background: accent }" />
            </div>
        </div>
        <div v-if="options.showValue" class="bg-value dw-value">{{ text }}</div>
    </div>
</template>

<style scoped>
.bg {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.bg-area {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 8px;
}
.bg-track {
    position: relative;
    overflow: hidden;
    border-radius: 6px;
    background: var(--d-track);
}
.bg-h .bg-track {
    width: 100%;
    height: clamp(8px, 30cqh, 36px);
}
.bg-v .bg-track {
    height: 100%;
    width: clamp(10px, 40cqw, 48px);
}
.bg-fill {
    position: absolute;
    left: 0;
    bottom: 0;
    transition: width 0.2s, height 0.2s;
}
.bg-h .bg-fill {
    top: 0;
}
.bg-v .bg-fill {
    right: 0;
}
.bg-value {
    flex: none;
    text-align: center;
    padding: 0 4px 5px;
    font-size: clamp(11px, 14cqmin, 22px);
}
</style>

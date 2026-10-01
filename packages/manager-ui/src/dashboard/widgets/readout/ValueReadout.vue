<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';
import { asNumber, formatValue, isNumber, numberOption } from '../../valueTypes';

const props = defineProps<WidgetProps>();

const text = computed(() => {
    const decimals = numberOption(props.options.decimals);
    const v = props.desc && isNumber(props.desc) ? (asNumber(props.value) ?? props.value) : props.value;
    return formatValue(v, decimals, props.options.showUnit ? props.desc?.unit : undefined);
});
</script>

<template>
    <div class="ro">
        <div class="dw-label">{{ label }}</div>
        <div class="ro-value dw-value" :class="{ 'ro-wrap': options.wrap }" :style="{ color: options.accent || undefined }">{{ text }}</div>
    </div>
</template>

<style scoped>
.ro {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.ro-value {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px 4px;
    font-size: clamp(11px, min(38cqh, 16cqw), 64px);
}
/* Long text breaks onto more lines, centred, instead of running off the sides. */
.ro-value.ro-wrap {
    white-space: normal;
    overflow-wrap: break-word;
    text-align: center;
    overflow: hidden;
}
</style>

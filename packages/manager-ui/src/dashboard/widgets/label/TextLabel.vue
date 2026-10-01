<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';
import { readableText } from '../../valueTypes';
import { useTheme } from '../../keys';

const props = defineProps<WidgetProps>();
const theme = useTheme();
// The accent colours the text only while it stays readable on the theme.
const textColor = computed(() => readableText(props.options.accent, theme?.value ?? 'dark'));

const FLEX = { left: 'flex-start', top: 'flex-start', center: 'center', middle: 'center', right: 'flex-end', bottom: 'flex-end' } as const;
const h = computed<'left' | 'center' | 'right'>(() => props.options.align ?? 'left');
const v = computed<'top' | 'middle' | 'bottom'>(() =>
    !props.options.valign || props.options.valign === 'auto' ? (props.options.frame ? 'top' : 'middle') : props.options.valign,
);
const vertical = computed(() => props.options.orientation === 'up' || props.options.orientation === 'down');

/** Lines line up along the text's own direction: across for horizontal text, along the height for vertical. */
const lineAlign = computed(() => {
    if (!vertical.value) return h.value;
    // Reading down, a line starts at the top; reading up (turned over), at the bottom.
    const start = props.options.orientation === 'down' ? 'top' : 'bottom';
    return v.value === 'middle' ? 'center' : v.value === start ? 'start' : 'end';
});
</script>

<template>
    <div
        class="lb"
        :class="{ 'lb-frame': options.frame }"
        :style="{ justifyContent: FLEX[h], alignItems: FLEX[v], borderColor: options.accent || undefined }"
    >
        <div class="lb-text" :class="vertical && `lb-${options.orientation}`" :style="{ color: textColor, textAlign: lineAlign }">{{ options.text }}</div>
    </div>
</template>

<style scoped>
.lb {
    box-sizing: border-box;
    display: flex;
    width: 100%;
    height: 100%;
    padding: 4px 8px;
}
.lb-frame {
    border: 2px solid var(--d-border);
    border-radius: 10px;
    padding: 6px 10px;
}
.lb-text {
    font-weight: var(--dw-label-weight, 600);
    white-space: pre-wrap;
    overflow: hidden;
    max-width: 100%;
    max-height: 100%;
    font-size: var(--dw-label-size, clamp(11px, 30cqh, 40px));
}
.lb-down,
.lb-up {
    writing-mode: vertical-rl;
    font-size: var(--dw-label-size, clamp(11px, 30cqw, 40px));
}
.lb-up {
    transform: rotate(180deg);
}
.lb-frame .lb-text {
    font-size: var(--dw-label-size, clamp(11px, 7cqmin, 18px));
}
</style>

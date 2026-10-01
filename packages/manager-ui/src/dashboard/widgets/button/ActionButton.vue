<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetProps } from '../../registry';
import { readableText } from '../../valueTypes';
import { useTheme } from '../../keys';

/** `progress`: a running script's "step/of"; `failure`: why the last run failed. */
const props = defineProps<WidgetProps & { busy?: boolean; progress?: string; failure?: string }>();
const emit = defineEmits<{ action: [] }>();

const theme = useTheme();
// A colour too dark (or light) for the theme keeps the border, not the text.
const colour = computed(() => props.options.color || 'var(--d-accent)');
const textColour = computed(() => (props.options.color ? readableText(props.options.color, theme?.value ?? 'dark') : 'var(--d-accent)'));
</script>

<template>
    <button
        class="bt"
        :class="{ 'bt-busy': busy }"
        :disabled="!interactive || (busy && !progress)"
        :style="{ borderColor: colour, color: textColour }"
        @click="emit('action')"
    >
        <span class="bt-text dw-value">{{ options.text || label }}</span>
        <span v-if="progress" class="bt-sub">{{ progress }} · tap to stop</span>
        <span v-else-if="failure" class="bt-sub bt-fail">{{ failure }}</span>
        <span v-if="failure && !progress" class="bt-fail-full">{{ failure }}</span>
    </button>
</template>

<style scoped>
.bt {
    width: 100%;
    height: 100%;
    border: 2px solid;
    border-radius: 7px;
    background: transparent;
    font-weight: var(--dw-label-weight, 600);
    font-size: var(--dw-label-size, clamp(11px, 24cqh, 24px));
    cursor: pointer;
    padding: 0 8px;
}
.bt:not(:disabled):active {
    filter: brightness(1.4);
}
.bt:disabled {
    cursor: default;
}
.bt {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
}
.bt-busy {
    opacity: 0.75;
}
.bt-sub {
    font-size: clamp(9px, 12cqh, 12px);
    font-weight: 500;
    color: var(--d-muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.bt-fail {
    color: var(--d-error);
}
/* Hover shows the whole failure over the button face. */
.bt {
    position: relative;
}
.bt-fail-full {
    display: none;
    position: absolute;
    inset: 0;
    align-items: center;
    justify-content: center;
    padding: 4px 8px;
    border-radius: 5px;
    background: var(--d-card);
    color: var(--d-error);
    font-size: clamp(9px, 12cqh, 13px);
    font-weight: 500;
    overflow-wrap: anywhere;
    overflow: auto;
}
.bt:hover .bt-fail-full {
    display: flex;
}
</style>

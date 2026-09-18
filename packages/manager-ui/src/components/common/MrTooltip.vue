<script setup lang="ts">
/**
 * CSS-hover tooltip for chrome that never scrolls (toolbar, header). Inside a
 * scroll box, or where touch users must reach the text, use `MrHelpTip`.
 */
import { TOOLTIP_BUBBLE_CLASS } from './tooltipBubble';

defineProps<{ text: string; width?: string }>();
</script>

<template>
    <div class="group/tb relative">
        <slot />
        <div
            class="hidden group-hover/tb:block absolute left-0 top-full mt-1 text-[10px]"
            :class="[TOOLTIP_BUBBLE_CLASS, width ?? 'w-48']"
            style="z-index: 9999"
        >
            {{ text }}
        </div>
    </div>
</template>

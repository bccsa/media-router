<script setup lang="ts">
/** Palette of dark-theme-friendly accents. Limited set keeps the picker tidy
 *  and avoids the operator inventing 50 shades of nearly-identical greens. */
const GROUP_COLORS = [
    '#ef4444', // red
    '#f97316', // orange
    '#f59e0b', // amber
    '#10b981', // emerald (matches the app accent)
    '#14b8a6', // teal
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#ec4899', // pink
] as const;

defineProps<{ modelValue: string | null }>();
defineEmits<{ 'update:modelValue': [value: string | null] }>();
</script>

<template>
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors"
            :class="modelValue === null ? 'border-foreground' : 'border-border'"
            title="No color"
            @click="$emit('update:modelValue', null)"
        >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="5" y1="5" x2="19" y2="19" />
            </svg>
        </button>
        <button
            v-for="c in GROUP_COLORS"
            :key="c"
            type="button"
            class="w-6 h-6 rounded-full border-2 transition-transform"
            :class="modelValue === c ? 'border-foreground scale-110' : 'border-transparent'"
            :style="{ backgroundColor: c }"
            :title="c"
            @click="$emit('update:modelValue', c)"
        />
    </div>
</template>

<script setup lang="ts">
defineProps<{ text: string; width?: string }>();
</script>

<template>
    <div class="group/tb relative">
        <slot />
        <div class="hidden group-hover/tb:block absolute left-0 top-full mt-1 p-2 rounded-md shadow-lg text-[10px] leading-relaxed pointer-events-none"
             :class="width ?? 'w-48'"
             style="z-index: 9999"
             :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }">
            {{ text }}
        </div>
    </div>
</template>

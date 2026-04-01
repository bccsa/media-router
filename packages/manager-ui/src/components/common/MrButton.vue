<script setup lang="ts">
defineProps<{
    variant?: 'primary' | 'secondary' | 'danger';
    size?: 'sm' | 'md';
    loading?: boolean;
}>();
</script>

<template>
    <button
        class="inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:opacity-50"
        :class="[
            size === 'sm' ? 'px-3 text-xs h-8' : 'px-4 py-2 text-sm',
            variant === 'danger' ? 'bg-red-500 text-white' :
            variant === 'secondary' ? 'bg-transparent text-foreground border border-border' :
            'bg-accent text-white',
        ]"
        :disabled="loading"
    >
        <svg v-if="loading" class="animate-spin -ml-1 mr-2 h-3 w-3" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <slot />
    </button>
</template>

<script setup lang="ts">
defineProps<{
    tabs: Array<{ id: string; label: string; badge?: string | number }>;
    modelValue: string;
}>();

defineEmits<{
    'update:modelValue': [value: string];
}>();
</script>

<template>
    <div class="flex gap-1 p-1 rounded-lg" :style="{ backgroundColor: 'var(--bg-secondary)' }">
        <button
            v-for="tab in tabs" :key="tab.id"
            @click="$emit('update:modelValue', tab.id)"
            class="px-3 py-1.5 text-xs font-medium rounded-md transition-all"
            :style="{
                backgroundColor: modelValue === tab.id ? 'var(--bg-card)' : 'transparent',
                color: modelValue === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                boxShadow: modelValue === tab.id ? '0 1px 2px rgba(0,0,0,0.1)' : 'none',
            }">
            {{ tab.label }}
            <span v-if="tab.badge !== undefined"
                  class="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full"
                  :style="{
                      backgroundColor: modelValue === tab.id ? 'var(--accent)' : 'var(--border-primary)',
                      color: modelValue === tab.id ? 'white' : 'var(--text-muted)',
                  }">
                {{ tab.badge }}
            </span>
        </button>
    </div>
</template>

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
    <div class="flex gap-1 p-1 rounded-lg bg-surface-alt">
        <button
            v-for="tab in tabs" :key="tab.id"
            @click="$emit('update:modelValue', tab.id)"
            class="px-3 py-1.5 text-xs font-medium rounded-md transition-all"
            :class="[
                modelValue === tab.id ? 'bg-card text-foreground shadow-sm' : 'text-muted',
            ]">
            {{ tab.label }}
            <span v-if="tab.badge !== undefined"
                  class="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full"
                  :class="[
                      modelValue === tab.id ? 'bg-accent text-white' : 'bg-border text-muted',
                  ]">
                {{ tab.badge }}
            </span>
        </button>
    </div>
</template>

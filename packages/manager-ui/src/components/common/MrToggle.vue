<script setup lang="ts">
defineProps<{
    modelValue?: boolean;
    label?: string;
    description?: string;
    disabled?: boolean;
}>();

defineEmits<{
    'update:modelValue': [value: boolean];
}>();
</script>

<template>
    <div class="flex items-center justify-between gap-3">
        <div v-if="label || description">
            <span v-if="label" class="text-xs font-medium text-foreground">{{ label }}</span>
            <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>
        </div>
        <button
            type="button"
            role="switch"
            :aria-checked="modelValue"
            :disabled="disabled"
            @click="$emit('update:modelValue', !modelValue)"
            class="relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-200 focus:outline-none"
            :class="[
                disabled ? 'opacity-50 cursor-not-allowed' : '',
                modelValue ? 'bg-accent' : 'bg-border',
            ]"
        >
            <span
                class="inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform duration-200"
                :class="modelValue ? 'translate-x-[18px]' : 'translate-x-0.5'"
                style="margin-top: 2px"
            />
        </button>
    </div>
</template>

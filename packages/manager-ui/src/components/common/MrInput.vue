<script setup lang="ts">
defineProps<{
    modelValue?: string | number;
    label?: string;
    description?: string;
    type?: 'text' | 'number' | 'password' | 'email';
    placeholder?: string;
    error?: string;
    disabled?: boolean;
    min?: number;
    max?: number;
}>();

defineEmits<{
    'update:modelValue': [value: string | number];
}>();
</script>

<template>
    <div class="space-y-1">
        <label v-if="label" class="block text-xs font-medium text-foreground">
            {{ label }}
        </label>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>
        <input
            :type="type ?? 'text'"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            :min="min"
            :max="max"
            @input="$emit('update:modelValue', type === 'number' ? Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number(($event.target as HTMLInputElement).value))) : ($event.target as HTMLInputElement).value)"
            class="w-full px-2.5 py-1.5 text-sm rounded-md outline-none transition-colors bg-input border text-foreground"
            :class="[
                disabled ? 'opacity-50 cursor-not-allowed' : '',
                error ? 'border-error' : 'border-border',
            ]"
        />
        <p v-if="error" class="text-[11px] text-error">{{ error }}</p>
    </div>
</template>

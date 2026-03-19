<script setup lang="ts">
defineProps<{
    modelValue?: string | number;
    label?: string;
    description?: string;
    type?: 'text' | 'number' | 'password' | 'email';
    placeholder?: string;
    error?: string;
    disabled?: boolean;
}>();

defineEmits<{
    'update:modelValue': [value: string | number];
}>();
</script>

<template>
    <div class="space-y-1">
        <label v-if="label" class="block text-xs font-medium" :style="{ color: 'var(--text-primary)' }">
            {{ label }}
        </label>
        <p v-if="description" class="text-[11px]" :style="{ color: 'var(--text-muted)' }">{{ description }}</p>
        <input
            :type="type ?? 'text'"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            @input="$emit('update:modelValue', type === 'number' ? Number(($event.target as HTMLInputElement).value) : ($event.target as HTMLInputElement).value)"
            class="w-full px-2.5 py-1.5 text-sm rounded-md outline-none transition-colors"
            :class="{ 'opacity-50 cursor-not-allowed': disabled }"
            :style="{
                backgroundColor: 'var(--bg-input)',
                border: error ? '1px solid var(--health-error)' : '1px solid var(--border-primary)',
                color: 'var(--text-primary)',
            }"
        />
        <p v-if="error" class="text-[11px]" :style="{ color: 'var(--health-error)' }">{{ error }}</p>
    </div>
</template>

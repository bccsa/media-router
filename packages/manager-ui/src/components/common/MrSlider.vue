<script setup lang="ts">
defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    showValue?: boolean;
}>();
defineEmits<{ 'update:modelValue': [value: number] }>();
</script>

<template>
    <div class="flex items-center gap-2">
        <input
            type="range"
            :min="min ?? 0"
            :max="max ?? 100"
            :step="step ?? 1"
            :value="modelValue"
            @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
            class="flex-1 h-1 accent-emerald-500 cursor-pointer"
        />
        <span v-if="showValue" class="text-xs w-10 text-right text-subtle">
            {{ modelValue }}
        </span>
    </div>
</template>

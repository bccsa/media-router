<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue';

const props = defineProps<{
    modelValue?: (string | number)[];
    label?: string;
    description?: string;
    options: Array<{ value: string | number; label: string }>;
    placeholder?: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: (string | number)[]] }>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const selected = computed<(string | number)[]>(() => props.modelValue ?? []);

const summary = computed(() => {
    if (!selected.value.length) return props.placeholder ?? 'None selected';
    return selected.value
        .map((v) => props.options.find((o) => o.value === v)?.label ?? String(v))
        .join(', ');
});

function isSelected(value: string | number): boolean {
    return selected.value.includes(value);
}

function toggle(value: string | number): void {
    const next = isSelected(value)
        ? selected.value.filter((v) => v !== value)
        : [...selected.value, value];
    emit('update:modelValue', next);
}

function onDocumentClick(e: MouseEvent) {
    if (rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false;
}

watch(open, (isOpen) => {
    if (isOpen) {
        setTimeout(() => document.addEventListener('mousedown', onDocumentClick), 0);
    } else {
        document.removeEventListener('mousedown', onDocumentClick);
    }
});

onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentClick));
</script>

<template>
    <div ref="rootRef" class="space-y-1 relative">
        <label v-if="label" class="block text-xs font-medium text-foreground">{{ label }}</label>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>

        <!-- Trigger -->
        <button
            type="button"
            :disabled="disabled || options.length === 0"
            @click="open = !open"
            class="w-full px-2.5 py-1.5 text-sm rounded-md text-left flex items-center justify-between outline-none transition-colors bg-input border border-border"
            :class="[
                disabled || options.length === 0 ? 'opacity-50 cursor-not-allowed' : '',
                selected.length ? 'text-foreground' : 'text-muted',
            ]"
        >
            <span class="truncate">{{
                options.length === 0 ? 'No options detected' : summary
            }}</span>
            <svg
                class="w-3 h-3 shrink-0 ml-1 transition-transform"
                :class="{ 'rotate-180': open }"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M19 9l-7 7-7-7" />
            </svg>
        </button>

        <!-- Dropdown -->
        <div
            v-if="open && options.length"
            class="absolute z-[999] w-full mt-1 rounded-md shadow-lg max-h-48 overflow-auto bg-card border border-border"
        >
            <div
                v-for="opt in options"
                :key="String(opt.value)"
                @click="toggle(opt.value)"
                class="px-2.5 py-1.5 text-sm cursor-pointer transition-colors hover:bg-surface-alt flex items-center gap-2"
                :class="[isSelected(opt.value) ? 'text-accent' : 'text-foreground']"
            >
                <span
                    class="inline-flex w-4 h-4 shrink-0 items-center justify-center rounded border"
                    :class="
                        isSelected(opt.value)
                            ? 'bg-accent border-accent text-white'
                            : 'border-border-alt'
                    "
                >
                    <svg
                        v-if="isSelected(opt.value)"
                        class="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="3"
                    >
                        <path d="M5 13l4 4L19 7" />
                    </svg>
                </span>
                <span class="truncate">{{ opt.label }}</span>
            </div>
        </div>
    </div>
</template>

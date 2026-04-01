<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps<{
    modelValue?: string | number;
    label?: string;
    description?: string;
    options: Array<{ value: string | number; label: string }>;
    placeholder?: string;
    searchable?: boolean;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
}>();

const open = ref(false);
const search = ref('');
const rootRef = ref<HTMLElement | null>(null);

const filtered = computed(() => {
    if (!search.value) return props.options;
    const q = search.value.toLowerCase();
    return props.options.filter((o) => o.label.toLowerCase().includes(q));
});

const selectedLabel = computed(() => {
    const opt = props.options.find((o) => o.value === props.modelValue);
    return opt?.label ?? props.placeholder ?? 'Select...';
});

function selectOption(value: string | number) {
    emit('update:modelValue', value);
    open.value = false;
    search.value = '';
}

// Close on click outside — uses document listener instead of Teleport overlay
// to avoid z-index stacking context issues
function onDocumentClick(e: MouseEvent) {
    if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
        open.value = false;
        search.value = '';
    }
}

watch(open, (isOpen) => {
    if (isOpen) {
        // Use setTimeout to avoid the opening click from immediately closing
        setTimeout(() => document.addEventListener('mousedown', onDocumentClick), 0);
    } else {
        document.removeEventListener('mousedown', onDocumentClick);
    }
});

onBeforeUnmount(() => {
    document.removeEventListener('mousedown', onDocumentClick);
});
</script>

<template>
    <div ref="rootRef" class="space-y-1 relative">
        <label v-if="label" class="block text-xs font-medium text-foreground">
            {{ label }}
        </label>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>

        <!-- Trigger -->
        <button
            type="button"
            :disabled="disabled"
            @click="open = !open"
            class="w-full px-2.5 py-1.5 text-sm rounded-md text-left flex items-center justify-between outline-none transition-colors bg-input border border-border"
            :class="[
                disabled ? 'opacity-50 cursor-not-allowed' : '',
                modelValue !== undefined ? 'text-foreground' : 'text-muted',
            ]">
            <span class="truncate">{{ selectedLabel }}</span>
            <svg class="w-3 h-3 shrink-0 ml-1 transition-transform" :class="{ 'rotate-180': open }"
                 fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path d="M19 9l-7 7-7-7" />
            </svg>
        </button>

        <!-- Dropdown -->
        <div v-if="open" class="absolute z-[999] w-full mt-1 rounded-md shadow-lg max-h-48 overflow-auto bg-card border border-border">
            <!-- Search -->
            <div v-if="searchable" class="p-1.5">
                <input v-model="search" type="text" placeholder="Search..."
                       class="w-full px-2 py-1 text-xs rounded outline-none bg-input border border-border-alt text-foreground"
                       @click.stop />
            </div>

            <!-- Options -->
            <div v-for="opt in filtered" :key="String(opt.value)"
                 @click="selectOption(opt.value)"
                 class="px-2.5 py-1.5 text-sm cursor-pointer transition-colors hover:bg-surface-alt"
                 :class="[
                     opt.value === modelValue ? 'text-accent bg-surface-alt' : 'text-foreground',
                 ]">
                {{ opt.label }}
            </div>

            <div v-if="filtered.length === 0" class="px-2.5 py-2 text-xs text-muted">
                No results
            </div>
        </div>
    </div>
</template>

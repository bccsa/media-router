<script setup lang="ts">
import { onUnmounted, watch, type Component } from 'vue';

interface StatusField {
    key: string;
    label: string;
    unit?: string;
}
interface StatusSection {
    id: string;
    label: string;
    fields: StatusField[];
}

const props = defineProps<{
    open: boolean;
    displayName: string;
    iconComponent: Component | null;
    iconColor?: string;
    sections: StatusSection[];
    statusData: Record<string, Record<string, unknown>> | undefined;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

function close(): void {
    emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
}

watch(
    () => props.open,
    (open) => {
        if (open) document.addEventListener('keydown', onKeydown);
        else document.removeEventListener('keydown', onKeydown);
    },
);

onUnmounted(() => document.removeEventListener('keydown', onKeydown));

function formatStatusValue(value: unknown, unit?: string): string {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    const str = typeof value === 'number' ? value.toLocaleString() : String(value);
    return unit ? `${str} ${unit}` : str;
}
</script>

<template>
    <Teleport to="body">
        <div
            v-if="open"
            class="fixed inset-0 flex items-center justify-center"
            style="z-index: 10000"
        >
            <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="close" />
            <div
                class="relative w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl shadow-2xl mx-4 bg-card border border-border"
            >
                <!-- Header -->
                <div
                    class="flex items-center justify-between px-5 py-3 sticky top-0 bg-card border-b border-border-alt"
                >
                    <div class="flex items-center gap-2">
                        <component
                            v-if="iconComponent"
                            :is="iconComponent"
                            :size="18"
                            :color="iconColor ?? 'var(--text-muted)'"
                        />
                        <h2 class="text-sm font-semibold text-foreground">
                            {{ displayName }} — Stats
                        </h2>
                    </div>
                    <button @click="close" class="p-1 rounded-md hover:bg-white/10 text-muted">
                        <svg
                            class="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
                <!-- Sections (static from manifest + dynamic from runtime) -->
                <div class="p-5 space-y-4">
                    <div v-for="section in sections" :key="section.id">
                        <h3 class="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
                            {{ section.label }}
                        </h3>
                        <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                            <template v-for="field in section.fields" :key="field.key">
                                <span class="text-xs text-muted">{{ field.label }}</span>
                                <span class="text-xs tabular-nums text-right text-foreground">
                                    {{
                                        formatStatusValue(
                                            statusData?.[section.id]?.[field.key],
                                            field.unit,
                                        )
                                    }}
                                </span>
                            </template>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </Teleport>
</template>

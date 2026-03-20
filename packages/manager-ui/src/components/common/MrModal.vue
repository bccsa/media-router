<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
    <Teleport to="body">
        <div class="fixed inset-0 z-50 flex items-center justify-center">
            <div class="fixed inset-0 bg-black/50 backdrop-blur-sm" @click="$emit('close')" />
            <div class="relative z-10 w-full max-w-md rounded-lg shadow-xl p-6"
                 :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-base font-semibold" :style="{ color: 'var(--text-primary)' }">{{ title }}</h3>
                    <button @click="$emit('close')" class="p-1 rounded-md" :style="{ color: 'var(--text-muted)' }">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <slot />
                <div v-if="$slots.footer" class="mt-4 flex justify-end gap-2">
                    <slot name="footer" />
                </div>
            </div>
        </div>
    </Teleport>
</template>

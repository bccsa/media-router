<script setup lang="ts">
import { useToast } from '@/composables/useToast';

const { toasts, dismiss } = useToast();
</script>

<template>
    <div
        class="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
        style="z-index: 10000"
    >
        <TransitionGroup name="toast">
            <div
                v-for="t in toasts"
                :key="t.id"
                class="pointer-events-auto max-w-md px-4 py-2 rounded-md shadow-lg text-sm bg-card border cursor-pointer"
                :class="t.kind === 'error' ? 'border-red-500/60 text-red-400' : 'border-border text-foreground'"
                @click="dismiss(t.id)"
            >
                {{ t.message }}
            </div>
        </TransitionGroup>
    </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
    transition:
        opacity 0.2s ease,
        transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
    opacity: 0;
    transform: translateY(8px);
}
</style>

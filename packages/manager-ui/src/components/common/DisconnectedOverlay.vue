<script setup lang="ts">
import { ref, watch } from 'vue';
import { useSocketStore } from '@/stores/socket';

const socket = useSocketStore();
// Delay showing the banner so a brief reconnect tick doesn't flash. If the
// socket comes back in under 1s, the user never sees the overlay.
const GRACE_MS = 1000;
const showing = ref(false);
let graceTimer: ReturnType<typeof setTimeout> | null = null;

watch(
    () => socket.connected,
    (connected) => {
        if (connected) {
            if (graceTimer) {
                clearTimeout(graceTimer);
                graceTimer = null;
            }
            showing.value = false;
        } else {
            if (graceTimer) return;
            graceTimer = setTimeout(() => {
                showing.value = true;
                graceTimer = null;
            }, GRACE_MS);
        }
    },
    { immediate: true },
);
</script>

<template>
    <Teleport to="body">
        <Transition name="disconnect-fade">
            <div
                v-if="showing"
                class="fixed inset-0 z-[2000] flex items-center justify-center"
                style="background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px)"
            >
                <div
                    class="rounded-xl shadow-2xl px-8 py-6 max-w-md mx-4 border border-error bg-card text-center"
                >
                    <div class="flex items-center justify-center mb-3">
                        <svg
                            width="40"
                            height="40"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="text-error"
                        >
                            <path d="M12 3v5m0 4v.01M12 21a9 9 0 1 1 0-18" />
                            <path d="M4 4l16 16" />
                        </svg>
                    </div>
                    <h2 class="text-lg font-semibold text-foreground mb-1">
                        Disconnected from Manager
                    </h2>
                    <p class="text-sm text-subtle mb-3">
                        The UI lost its connection. Trying to reconnect…
                    </p>
                    <div class="flex items-center justify-center gap-2 text-xs text-muted">
                        <span class="inline-block w-2 h-2 rounded-full bg-error animate-pulse" />
                        <span>No live updates until reconnected</span>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.disconnect-fade-enter-active,
.disconnect-fade-leave-active {
    transition: opacity 0.2s ease;
}
.disconnect-fade-enter-from,
.disconnect-fade-leave-to {
    opacity: 0;
}
</style>

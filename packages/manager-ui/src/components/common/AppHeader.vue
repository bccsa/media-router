<script setup lang="ts">
import { useSocketStore } from '@/stores/socket';
import { useThemeStore } from '@/stores/theme';

const socket = useSocketStore();
const theme = useThemeStore();
</script>

<template>
    <header class="h-12 flex items-center justify-between px-4 shrink-0"
            :style="{ backgroundColor: 'var(--bg-card)', borderBottom: '1px solid var(--border-primary)' }">
        <div class="flex items-center gap-3">
            <div class="w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold text-white"
                 :style="{ backgroundColor: 'var(--accent)' }">MR</div>
            <span class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">Media Router</span>
        </div>
        <div class="flex items-center gap-3">
            <div class="flex items-center gap-1.5">
                <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: socket.connected ? 'var(--health-ok)' : 'var(--health-error)' }" />
                <span class="text-xs" :style="{ color: 'var(--text-muted)' }">{{ socket.connected ? 'Connected' : 'Disconnected' }}</span>
            </div>
            <button @click="theme.toggle()" class="p-1.5 rounded-md" :style="{ color: 'var(--text-muted)' }">
                <svg v-if="theme.isDark" class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" />
                </svg>
                <svg v-else class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
            </button>
        </div>
    </header>
</template>

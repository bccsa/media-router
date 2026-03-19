<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from '@/components/common/AppHeader.vue';
import AppSidebar from '@/components/common/AppSidebar.vue';
import { useSocketStore } from '@/stores/socket';
import { useThemeStore } from '@/stores/theme';

const socket = useSocketStore();
useThemeStore(); // Ensure theme is applied

onMounted(() => {
    socket.connect();
});
</script>

<template>
    <div class="h-screen flex flex-col" :style="{ backgroundColor: 'var(--bg-primary)' }">
        <AppHeader />
        <div class="flex flex-1 overflow-hidden">
            <AppSidebar />
            <main class="flex-1 overflow-auto" :style="{ backgroundColor: 'var(--bg-secondary)' }">
                <RouterView />
            </main>
        </div>
    </div>
</template>

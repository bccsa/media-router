<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from '@/components/common/AppHeader.vue';
import AppSidebar from '@/components/common/AppSidebar.vue';
import DisconnectedOverlay from '@/components/common/DisconnectedOverlay.vue';
import { useSocketStore } from '@/stores/socket';
import { useThemeStore } from '@/stores/theme';

const socket = useSocketStore();
useThemeStore(); // Ensure theme is applied

onMounted(() => {
    socket.connect();
});
</script>

<template>
    <div class="h-screen flex flex-col bg-surface">
        <AppHeader />
        <div class="flex flex-1 overflow-hidden">
            <AppSidebar />
            <main class="flex-1 overflow-auto bg-surface-alt">
                <RouterView />
            </main>
        </div>
        <DisconnectedOverlay />
    </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import AppHeader from '@/components/common/AppHeader.vue';
import AppSidebar from '@/components/common/AppSidebar.vue';
import DisconnectedOverlay from '@/components/common/DisconnectedOverlay.vue';
import MrToastHost from '@/components/common/MrToastHost.vue';
import { useSocketStore } from '@/stores/socket';
import { useThemeStore } from '@/stores/theme';
import { useTopics } from '@/composables/useTopics';

const socket = useSocketStore();
useThemeStore(); // Ensure theme is applied

// What every view needs: the router list, their load, the sidebar groups.
useTopics(() => ['/engines/+/info', '/engines/+/system', '/groups']);

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
        <MrToastHost />
    </div>
</template>

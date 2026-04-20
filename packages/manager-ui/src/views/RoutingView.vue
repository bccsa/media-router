<script setup lang="ts">
import RoutingEditor from '@/components/routing/RoutingEditor.vue';
defineProps<{ engineId: string }>();
</script>

<template>
    <div class="w-full h-full">
        <RoutingEditor :key="engineId" :engine-id="engineId" />
    </div>
</template>

<style scoped>
div {
    height: calc(100vh - 48px); /* Full height minus header */
}
</style>

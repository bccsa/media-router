<script setup lang="ts">
defineProps<{ dashboards: Array<{ id: string; name: string }>; current?: string }>();
const emit = defineEmits<{ pick: [id: string]; close: [] }>();
</script>

<template>
    <div class="dm-scrim" @click.self="emit('close')">
        <div class="dm-panel">
            <div class="dm-title">Dashboards</div>
            <button
                v-for="d in dashboards"
                :key="d.id"
                class="dm-item"
                :class="{ 'dm-current': d.id === current }"
                @click="emit('pick', d.id)"
            >
                {{ d.name }}
            </button>
            <div v-if="dashboards.length === 0" class="dm-empty">No dashboards in this profile.</div>
        </div>
    </div>
</template>

<style scoped>
.dm-scrim {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 44px 8px 8px;
}
.dm-panel {
    min-width: 220px;
    max-width: min(90vw, 360px);
    max-height: 80%;
    overflow: auto;
    background: var(--d-card);
    border: 1px solid var(--d-border);
    border-radius: 10px;
    padding: 8px;
}
.dm-title {
    font-size: 12px;
    color: var(--d-muted);
    padding: 4px 8px 8px;
}
.dm-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 12px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--d-text);
    font-size: 16px;
    cursor: pointer;
}
.dm-item:hover,
.dm-current {
    background: var(--d-track);
}
.dm-empty {
    padding: 12px;
    color: var(--d-muted);
}
</style>

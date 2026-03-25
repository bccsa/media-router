<script setup lang="ts">
import { onMounted } from 'vue';
import { useSocketStore } from '@/stores/socket';
import { useModuleStore } from '@/stores/modules';
import MixerStrip from '@/components/MixerStrip.vue';

const socketStore = useSocketStore();
const moduleStore = useModuleStore();

onMounted(() => {
    socketStore.connect();
});

function onVolume(moduleId: string, volume: number) {
    // Update local store immediately (server won't echo back to sender)
    moduleStore.updateSetting(moduleId, 'volume', volume);
    socketStore.emit('volume', { moduleId, volume });
}

function onMute(moduleId: string, muted: boolean) {
    // Update local store immediately (server won't echo back to sender)
    moduleStore.updateSetting(moduleId, 'audioEnabled', !muted);
    socketStore.emit('mute', { moduleId, muted });
}

function startEngine() {
    moduleStore.engineRunning = true;
    socketStore.emit('start');
}

function stopEngine() {
    moduleStore.engineRunning = false;
    socketStore.emit('stop');
}
</script>

<template>
    <div class="lcp-root">
        <!-- Header -->
        <header class="lcp-header">
            <div class="header-left">
                <div class="status-dot" :style="{ backgroundColor: socketStore.connected ? '#10b981' : '#6b7280' }"></div>
                <h1 class="header-title">Media Router</h1>
                <span class="header-subtitle">Local Control Panel</span>
                <span v-if="moduleStore.engineIp" class="header-ip">{{ moduleStore.engineIp }}</span>
                <span v-if="moduleStore.buildNumber" class="header-build">{{ moduleStore.buildNumber }}</span>
            </div>
            <div class="header-right">
                <button v-if="moduleStore.engineRunning" class="engine-btn stop" @click="stopEngine">Stop</button>
                <button v-else class="engine-btn start" @click="startEngine">Start</button>
            </div>
        </header>

        <!-- Mixer strips -->
        <main class="mixer-area">
            <div v-if="moduleStore.visibleModules.length === 0" class="empty-state">
                <p v-if="!socketStore.connected">Connecting to engine...</p>
                <p v-else-if="!moduleStore.engineRunning">Engine is stopped</p>
                <p v-else>No modules visible on LCP</p>
            </div>
            <div v-else class="mixer-row">
                <MixerStrip
                    v-for="mod in moduleStore.visibleModules"
                    :key="mod.instanceId"
                    :module="mod"
                    @volume="onVolume"
                    @mute="onMute"
                />
            </div>
        </main>
    </div>
</template>

<style>
/* Global styles */
:root {
    --bg-primary: #0f1117;
    --bg-card: #232735;
    --bg-secondary: #141720;
    --accent: #10b981;
    --accent-text: #10b981;
    --text-primary: #f1f5f9;
    --text-secondary: #94a3b8;
    --text-muted: #64748b;
    --border-primary: #2d3348;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body { background: var(--bg-primary); color: var(--text-primary); font-family: system-ui, -apple-system, sans-serif; }
#app { height: 100%; }
</style>

<style scoped>
.lcp-root {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
}

.lcp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-primary);
    flex-shrink: 0;
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.header-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--text-primary);
}

.header-subtitle {
    font-size: 12px;
    color: var(--text-muted);
}

.header-ip {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--bg-secondary);
}

.header-build {
    font-size: 10px;
    color: var(--text-muted);
    opacity: 0.7;
}

.header-right {
    display: flex;
    gap: 8px;
}

.engine-btn {
    padding: 6px 16px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    touch-action: manipulation;
}

.engine-btn.start {
    background: var(--accent);
    color: white;
}

.engine-btn.stop {
    background: #ef4444;
    color: white;
}

.mixer-area {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 12px;
}

.empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 14px;
}

.mixer-row {
    display: flex;
    gap: 8px;
    height: 100%;
    align-items: stretch;
}
</style>

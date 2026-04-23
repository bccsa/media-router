<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSocketStore } from '@/stores/socket';
import { useModuleStore } from '@/stores/modules';
import { patch } from '@/composables/usePatch';
import MixerStrip from '@/components/MixerStrip.vue';
import { getStripComponent } from '@/composables/usePluginStripComponent';

const socketStore = useSocketStore();
const moduleStore = useModuleStore();

const isDark = ref(localStorage.getItem('lcp-theme') !== 'light');
function toggleTheme() {
    isDark.value = !isDark.value;
    localStorage.setItem('lcp-theme', isDark.value ? 'dark' : 'light');
    document.documentElement.classList.toggle('light', !isDark.value);
}

onMounted(() => {
    socketStore.connect();
    if (!isDark.value) document.documentElement.classList.add('light');
});

function onVolume(moduleId: string, volume: number) {
    moduleStore.updateSetting(moduleId, 'volume', volume);
    patch.moduleSetting(moduleId, 'volume', volume);
}

function onMute(moduleId: string, muted: boolean) {
    moduleStore.updateSetting(moduleId, 'audioEnabled', !muted);
    patch.moduleSetting(moduleId, 'audioEnabled', !muted);
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
                <div
                    class="status-dot"
                    :class="socketStore.connected ? 'bg-accent' : 'bg-stopped'"
                ></div>
                <h1 class="header-title">Media Router</h1>
                <span class="header-subtitle">Local Control Panel</span>
                <span v-if="moduleStore.engineIps.length > 0" class="header-ip">{{
                    moduleStore.engineIps.join(', ')
                }}</span>
                <span v-if="moduleStore.buildNumber" class="header-build">{{
                    moduleStore.buildNumber
                }}</span>
            </div>
            <div class="header-right">
                <button
                    class="theme-btn"
                    @click="toggleTheme"
                    :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
                >
                    <svg
                        v-if="isDark"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <circle cx="12" cy="12" r="5" />
                        <line x1="12" y1="1" x2="12" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="23" />
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                        <line x1="1" y1="12" x2="3" y2="12" />
                        <line x1="21" y1="12" x2="23" y2="12" />
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                    <svg
                        v-else
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                </button>
                <button
                    v-if="moduleStore.engineRunning"
                    class="engine-btn stop"
                    @click="stopEngine"
                >
                    Stop
                </button>
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
                <component
                    v-for="mod in moduleStore.visibleModules"
                    :key="mod.instanceId"
                    :is="getStripComponent(mod.pluginId) ?? MixerStrip"
                    :module="mod"
                    @volume="onVolume"
                    @mute="onMute"
                />
            </div>
        </main>
    </div>
</template>

<style>
/* Global styles — dark mode (default) */
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

/* Light mode */
:root.light {
    --bg-primary: #f0f2f5;
    --bg-card: #ffffff;
    --bg-secondary: #e5e7eb;
    --accent: #10b981;
    --accent-text: #059669;
    --text-primary: #0f172a;
    --text-secondary: #475569;
    --text-muted: #94a3b8;
    --border-primary: #d1d5db;
}

* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}
html,
body {
    height: 100%;
    overflow: hidden;
}
body {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family:
        system-ui,
        -apple-system,
        sans-serif;
    -webkit-font-smoothing: antialiased;
}
#app {
    height: 100%;
}
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
    align-items: center;
    gap: 8px;
}

.theme-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    touch-action: manipulation;
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

/* Landscape: compact header, more space for faders */
@media (orientation: landscape) and (max-height: 500px) {
    .lcp-header {
        padding: 4px 12px;
    }
    .header-title {
        font-size: 14px;
    }
    .header-subtitle {
        display: none;
    }
    .mixer-area {
        padding: 6px;
    }
    .mixer-row {
        gap: 4px;
    }
}

/* Portrait small phones: tighter padding */
@media (orientation: portrait) and (max-width: 500px) {
    .lcp-header {
        padding: 8px 10px;
    }
    .mixer-area {
        padding: 8px;
    }
    .mixer-row {
        gap: 4px;
    }
}

/* Safe area insets for notched devices / iOS */
@supports (padding: env(safe-area-inset-top)) {
    .lcp-header {
        padding-top: max(10px, env(safe-area-inset-top));
        padding-left: max(16px, env(safe-area-inset-left));
        padding-right: max(16px, env(safe-area-inset-right));
    }
    .mixer-area {
        padding-bottom: max(12px, env(safe-area-inset-bottom));
        padding-left: max(12px, env(safe-area-inset-left));
        padding-right: max(12px, env(safe-area-inset-right));
    }
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';
import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';
import MrToggle from '@/components/common/MrToggle.vue';

const theme = useThemeStore();
const socket = useSocketStore();
const engineStore = useEngineStore();

const engineCount = computed(() => engineStore.engineList.length);
const onlineCount = computed(() => engineStore.engineList.filter((e) => e.online).length);
const managerUrl = computed(() => typeof location !== 'undefined' ? location.origin : '—');
</script>

<template>
    <div class="p-6 max-w-2xl space-y-4">
        <h1 class="text-xl font-semibold" :style="{ color: 'var(--text-primary)' }">Settings</h1>

        <!-- Appearance -->
        <div class="rounded-lg overflow-hidden" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
            <div class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider"
                 :style="{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-secondary)' }">
                Appearance
            </div>
            <div class="px-5 py-4">
                <MrToggle :model-value="theme.isDark" @update:model-value="theme.toggle()"
                          label="Dark Mode" description="Use dark colour scheme" />
            </div>
        </div>

        <!-- Connection -->
        <div class="rounded-lg overflow-hidden" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
            <div class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider"
                 :style="{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-secondary)' }">
                Connection
            </div>
            <div class="divide-y" :style="{ borderColor: 'var(--border-secondary)' }">
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Socket.IO</span>
                    <div class="flex items-center gap-1.5">
                        <div class="w-2 h-2 rounded-full"
                             :style="{ backgroundColor: socket.connected ? 'var(--health-ok)' : 'var(--health-error)' }" />
                        <span class="text-xs" :style="{ color: 'var(--text-secondary)' }">
                            {{ socket.connected ? 'Connected' : 'Disconnected' }}
                        </span>
                    </div>
                </div>
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Engines</span>
                    <span class="text-xs" :style="{ color: 'var(--text-secondary)' }">
                        {{ onlineCount }}/{{ engineCount }} online
                    </span>
                </div>
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Manager URL</span>
                    <span class="text-xs font-mono" :style="{ color: 'var(--text-muted)' }">
                        {{ managerUrl }}
                    </span>
                </div>
            </div>
        </div>

        <!-- About -->
        <div class="rounded-lg overflow-hidden" :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
            <div class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider"
                 :style="{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-secondary)' }">
                About
            </div>
            <div class="px-5 py-4 space-y-2">
                <div class="flex justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Application</span>
                    <span class="text-xs" :style="{ color: 'var(--text-primary)' }">Media Router</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Version</span>
                    <span class="text-xs" :style="{ color: 'var(--text-primary)' }">2.0.0</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-sm" :style="{ color: 'var(--text-secondary)' }">Organisation</span>
                    <span class="text-xs" :style="{ color: 'var(--text-primary)' }">BCC South Africa</span>
                </div>
            </div>
        </div>
    </div>
</template>

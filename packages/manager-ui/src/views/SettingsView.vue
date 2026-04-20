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
const managerUrl = computed(() => (typeof location !== 'undefined' ? location.origin : '—'));
</script>

<template>
    <div class="p-6 max-w-2xl space-y-4">
        <h1 class="text-xl font-semibold text-foreground">Settings</h1>

        <!-- Appearance -->
        <div class="rounded-lg overflow-hidden bg-card border border-border">
            <div
                class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border-alt"
            >
                Appearance
            </div>
            <div class="px-5 py-4">
                <MrToggle
                    :model-value="theme.isDark"
                    @update:model-value="theme.toggle()"
                    label="Dark Mode"
                    description="Use dark colour scheme"
                />
            </div>
        </div>

        <!-- Connection -->
        <div class="rounded-lg overflow-hidden bg-card border border-border">
            <div
                class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border-alt"
            >
                Connection
            </div>
            <div class="divide-y divide-border-alt">
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm text-subtle">Socket.IO</span>
                    <div class="flex items-center gap-1.5">
                        <div
                            class="w-2 h-2 rounded-full"
                            :class="socket.connected ? 'bg-ok' : 'bg-error'"
                        />
                        <span class="text-xs text-subtle">
                            {{ socket.connected ? 'Connected' : 'Disconnected' }}
                        </span>
                    </div>
                </div>
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm text-subtle">Engines</span>
                    <span class="text-xs text-subtle">
                        {{ onlineCount }}/{{ engineCount }} online
                    </span>
                </div>
                <div class="px-5 py-3 flex items-center justify-between">
                    <span class="text-sm text-subtle">Manager URL</span>
                    <span class="text-xs font-mono text-muted">
                        {{ managerUrl }}
                    </span>
                </div>
            </div>
        </div>

        <!-- About -->
        <div class="rounded-lg overflow-hidden bg-card border border-border">
            <div
                class="px-5 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted border-b border-border-alt"
            >
                About
            </div>
            <div class="px-5 py-4 space-y-2">
                <div class="flex justify-between">
                    <span class="text-sm text-subtle">Application</span>
                    <span class="text-xs text-foreground">Media Router</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-sm text-subtle">Version</span>
                    <span class="text-xs text-foreground">2.0.0</span>
                </div>
                <div class="flex justify-between">
                    <span class="text-sm text-subtle">Organisation</span>
                    <span class="text-xs text-foreground">BCC South Africa</span>
                </div>
            </div>
        </div>
    </div>
</template>

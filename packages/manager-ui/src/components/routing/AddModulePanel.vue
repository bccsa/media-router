<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import MrButton from '@/components/common/MrButton.vue';

interface PluginInfo {
    pluginId: string; displayName: string; description: string;
    category: string; ports: Array<{ id: string; direction: string; streamType: string; label: string }>;
    configSchema: Record<string, unknown>;
}

const emit = defineEmits<{ close: []; add: [plugin: PluginInfo, displayName: string] }>();

const plugins = ref<PluginInfo[]>([]);
const loading = ref(true);
const searchQuery = ref('');
const selectedPlugin = ref<PluginInfo | null>(null);
const moduleName = ref('');

onMounted(async () => {
    try {
        const res = await fetch('/api/v1/plugins');
        if (res.ok) plugins.value = await res.json();
    } catch (err) {
        console.warn('[AddModulePanel] Failed to load plugins', err);
    } finally { loading.value = false; }
});

const categories = ['protocol', 'codec', 'processing', 'utility'];
const categoryLabels: Record<string, string> = { protocol: 'Protocol', codec: 'Codec', processing: 'Processing', utility: 'Utility' };

const filteredPlugins = computed(() => {
    if (!searchQuery.value) return plugins.value;
    const q = searchQuery.value.toLowerCase();
    return plugins.value.filter((p) => p.displayName.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
});

const groupedPlugins = computed(() => {
    const groups: Record<string, PluginInfo[]> = {};
    for (const cat of categories) {
        const items = filteredPlugins.value.filter((p) => p.category === cat);
        if (items.length > 0) groups[cat] = items;
    }
    return groups;
});

function selectPlugin(plugin: PluginInfo) { selectedPlugin.value = plugin; moduleName.value = plugin.displayName; }
function addModule() { if (selectedPlugin.value) emit('add', selectedPlugin.value, moduleName.value || selectedPlugin.value.displayName); }

function portColor(st: string) { return st === 'audio/pcm' ? 'var(--port-audio-pcm)' : st === 'muxed/mpegts' ? 'var(--port-muxed-mpegts)' : st === 'video/raw' ? 'var(--port-video-raw)' : '#6b7280'; }
</script>

<template>
    <div class="fixed right-0 top-0 h-screen w-80 z-20 flex flex-col shadow-xl"
         :style="{ backgroundColor: 'var(--bg-card)', borderLeft: '1px solid var(--border-primary)' }">
        <div class="flex items-center justify-between px-4 py-3 shrink-0" :style="{ borderBottom: '1px solid var(--border-primary)' }">
            <h3 class="text-sm font-semibold" :style="{ color: 'var(--text-primary)' }">Add Module</h3>
            <button @click="$emit('close')" class="p-1 rounded-md" :style="{ color: 'var(--text-muted)' }">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
        </div>

        <div class="px-4 py-2 shrink-0">
            <input v-model="searchQuery" type="text" placeholder="Search plugins..." class="w-full px-3 py-1.5 text-sm rounded-md"
                   :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }" />
        </div>

        <div class="flex-1 overflow-y-auto px-4 py-2">
            <div v-if="loading" class="text-center py-8 text-sm" :style="{ color: 'var(--text-muted)' }">Loading...</div>

            <template v-else-if="selectedPlugin">
                <button class="flex items-center gap-1 text-xs mb-3" :style="{ color: 'var(--accent-text)' }" @click="selectedPlugin = null">
                    ← Back
                </button>
                <div class="space-y-3">
                    <div>
                        <div class="text-sm font-medium" :style="{ color: 'var(--text-primary)' }">{{ selectedPlugin.displayName }}</div>
                        <div class="text-xs mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ selectedPlugin.description }}</div>
                    </div>
                    <div v-if="selectedPlugin.ports.length > 0">
                        <div class="text-[10px] font-semibold uppercase tracking-wider mb-1.5" :style="{ color: 'var(--text-muted)' }">Ports</div>
                        <div class="space-y-1">
                            <div v-for="port in selectedPlugin.ports" :key="port.id" class="flex items-center gap-2 text-xs" :style="{ color: 'var(--text-secondary)' }">
                                <div class="w-2 h-2 rounded-full" :style="{ backgroundColor: portColor(port.streamType) }" />
                                <span>{{ port.label || port.id }}</span>
                                <span class="text-[10px] px-1 rounded" :style="{ color: 'var(--text-muted)', backgroundColor: 'var(--border-primary)' }">{{ port.direction }}</span>
                            </div>
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs font-medium mb-1" :style="{ color: 'var(--text-secondary)' }">Display Name</label>
                        <input v-model="moduleName" type="text" class="w-full px-3 py-1.5 text-sm rounded-md"
                               :style="{ backgroundColor: 'var(--bg-input)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }" />
                    </div>
                </div>
            </template>

            <template v-else>
                <div v-for="(items, category) in groupedPlugins" :key="category" class="mb-4">
                    <div class="text-[10px] font-semibold uppercase tracking-wider mb-1.5 px-1" :style="{ color: 'var(--text-muted)' }">
                        {{ categoryLabels[category] || category }}
                    </div>
                    <button v-for="plugin in items" :key="plugin.pluginId" @click="selectPlugin(plugin)"
                            class="w-full text-left px-3 py-2 rounded-md text-sm transition-colors" :style="{ color: 'var(--text-secondary)' }">
                        <div class="font-medium text-xs" :style="{ color: 'var(--text-primary)' }">{{ plugin.displayName }}</div>
                        <div class="text-[11px] mt-0.5" :style="{ color: 'var(--text-muted)' }">{{ plugin.description }}</div>
                    </button>
                </div>
                <div v-if="Object.keys(groupedPlugins).length === 0" class="text-center py-8 text-sm" :style="{ color: 'var(--text-muted)' }">No plugins found.</div>
            </template>
        </div>

        <div v-if="selectedPlugin" class="px-4 py-3 flex justify-end gap-2 shrink-0" :style="{ borderTop: '1px solid var(--border-primary)' }">
            <MrButton variant="secondary" size="sm" @click="selectedPlugin = null">Cancel</MrButton>
            <MrButton size="sm" @click="addModule">Add Module</MrButton>
        </div>
    </div>
</template>

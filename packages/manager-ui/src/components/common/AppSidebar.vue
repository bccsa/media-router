<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useEngineStore } from '@/stores/engines';
import { statColorClass } from '@/composables/useStatColor';

const route = useRoute();
const engineStore = useEngineStore();
const open = ref(false);

// Close sidebar on route change (mobile)
watch(() => route.path, () => { open.value = false; });
</script>

<template>
    <!-- Mobile hamburger button -->
    <button class="fixed top-2 left-2 z-50 p-2 rounded-md md:hidden bg-card border border-border text-foreground"
            @click="open = !open">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <template v-if="!open">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
            </template>
            <template v-else>
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="6" y1="18" x2="18" y2="6" />
            </template>
        </svg>
    </button>

    <!-- Mobile overlay -->
    <div v-if="open" class="fixed inset-0 z-30 bg-black/50 md:hidden" @click="open = false" />

    <!-- Sidebar -->
    <aside class="shrink-0 flex flex-col h-full overflow-y-auto transition-transform duration-200 w-[220px]
                  fixed z-40 md:relative md:translate-x-0 bg-sidebar border-r border-border"
           :class="open ? 'translate-x-0' : '-translate-x-full'">
        <nav class="flex-1 py-3 px-2 space-y-4">
            <!-- Engines section -->
            <div>
                <RouterLink to="/engines"
                            class="flex items-center justify-between px-3 py-1 mb-1 text-muted">
                    <span class="text-[10px] font-semibold uppercase tracking-wider">Engines</span>
                    <span class="text-[10px]">{{ engineStore.engineList.length }}</span>
                </RouterLink>
                <div class="space-y-0.5">
                    <RouterLink v-for="engine in engineStore.engineList" :key="engine.engineId"
                                :to="`/routing/${engine.engineId}`"
                                class="flex flex-col px-3 py-1.5 rounded-md text-sm transition-colors"
                                :class="route.path.includes(engine.engineId) ? 'text-accent-fg bg-accent-muted' : 'text-subtle'">
                        <div class="flex items-center gap-2">
                            <div class="w-2 h-2 rounded-full shrink-0"
                                 :class="engine.online ? 'bg-ok' : 'bg-stopped'" />
                            <span class="truncate text-xs">{{ engine.name }}</span>
                        </div>
                        <div v-if="engine.system && engine.online" class="flex gap-2 pl-4 mt-0.5">
                            <span class="text-[9px] tabular-nums" :class="statColorClass(engine.system.cpu, 70, 90)">
                                CPU {{ engine.system.cpu }}%
                            </span>
                            <span class="text-[9px] tabular-nums" :class="statColorClass(engine.system.mem, 80, 95)">
                                MEM {{ engine.system.mem }}%
                            </span>
                            <span v-if="engine.system.temp !== null" class="text-[9px] tabular-nums"
                                  :class="statColorClass(engine.system.temp, 70, 80)">
                                {{ engine.system.temp }}°C
                            </span>
                        </div>
                    </RouterLink>
                    <div v-if="engineStore.engineList.length === 0" class="px-3 py-1.5 text-xs text-muted">
                        No engines
                    </div>
                </div>
            </div>

            <!-- Settings -->
            <div>
                <div class="px-3 py-1 mb-1">
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-muted">System</span>
                </div>
                <RouterLink to="/settings"
                            class="flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors"
                            :class="route.path === '/settings' ? 'text-accent-fg bg-accent-muted' : 'text-subtle'">
                    Settings
                </RouterLink>
            </div>
        </nav>
        <div class="px-4 py-3 text-[10px] text-muted border-t border-border">
            Media Router v2.0
        </div>
    </aside>
</template>

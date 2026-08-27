<script setup lang="ts">
import { useRoute } from 'vue-router';
import type { EngineState } from '@/stores/engines';
import { statColorClass } from '@/composables/useStatColor';
import { getLucideIcon } from '@/composables/useLucideIcons';

defineProps<{ engine: EngineState }>();
const emit = defineEmits<{ contextmenu: [ev: MouseEvent, engineId: string] }>();
const route = useRoute();
</script>

<template>
    <RouterLink
        :to="`/routing/${engine.engineId}`"
        class="engine-row flex flex-col px-3 py-1.5 rounded-md text-sm transition-colors cursor-grab active:cursor-grabbing"
        :class="
            route.params.engineId === engine.engineId
                ? 'text-accent-fg bg-accent-muted'
                : 'text-subtle'
        "
        @contextmenu.prevent="(ev: MouseEvent) => emit('contextmenu', ev, engine.engineId)"
    >
        <div class="flex items-center gap-2">
            <div
                class="w-2 h-2 rounded-full shrink-0"
                :class="engine.online ? 'bg-ok' : 'bg-stopped'"
            />
            <span class="truncate text-xs">{{ engine.name }}</span>
        </div>
        <div v-if="engine.system && engine.online" class="flex gap-2 pl-4 mt-0.5">
            <span
                class="text-[9px] tabular-nums"
                :class="statColorClass(engine.system.cpu, 70, 90)"
            >
                CPU {{ engine.system.cpu }}%
            </span>
            <span
                class="text-[9px] tabular-nums"
                :class="statColorClass(engine.system.mem, 80, 95)"
            >
                MEM {{ engine.system.mem }}%
            </span>
            <span
                v-if="engine.system.temp !== null"
                class="text-[9px] tabular-nums"
                :class="statColorClass(engine.system.temp, 70, 80)"
            >
                {{ engine.system.temp }}°C
            </span>
            <!-- Icon-only (no tooltip); aria-label carries meaning for a11y and
                 is a stable hook independent of async icon resolution. -->
            <span
                v-if="engine.system.undervoltage"
                class="text-warning shrink-0 inline-flex items-center"
                aria-label="Under-voltage detected"
            >
                <component :is="getLucideIcon('zap')" :size="11" />
            </span>
        </div>
    </RouterLink>
</template>

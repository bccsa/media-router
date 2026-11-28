<script setup lang="ts">
/** The routing editor's floating toolbar. Panels it opens live in `ui`, shown by RoutingOverlays. */
import MrButton from '@/components/common/MrButton.vue';
import MrTooltip from '@/components/common/MrTooltip.vue';
import RoutingModuleFinder from './RoutingModuleFinder.vue';
import type { RoutingUi } from './RoutingOverlays.vue';
import type { EngineState } from '@/stores/engines';
import { engineActions } from '@/utils/engineActions';

const props = defineProps<{
    engineId: string;
    engine: EngineState | undefined;
    ui: RoutingUi;
    selectedCount: number;
}>();
const focusMode = defineModel<boolean>('focusMode', { required: true });
const selectMode = defineModel<boolean>('selectMode', { required: true });
const emit = defineEmits<{
    toggleAdd: [];
    fit: [];
    format: [];
    focusModule: [moduleId: string];
}>();
</script>

<template>
    <div
        class="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap no-scrollbar toolbar-h"
    >
        <!-- Engine start/stop -->
        <MrTooltip
            :text="
                engine?.running ? 'Stop all running modules' : 'Start all modules on this engine'
            "
        >
            <MrButton
                v-if="engine?.running"
                size="sm"
                variant="danger"
                @click="engineActions.setRunning(props.engineId, false)"
            >
                Stop
            </MrButton>
            <MrButton v-else size="sm" @click="engineActions.setRunning(props.engineId, true)">
                Start
            </MrButton>
        </MrTooltip>

        <MrTooltip text="Stop all modules, restart PipeWire, and restart modules" width="w-52">
            <MrButton size="sm" variant="secondary" @click="ui.showResetConfirm = true"
                >Reset</MrButton
            >
        </MrTooltip>

        <!-- Engine settings link -->
        <MrTooltip text="Engine settings and profiles" width="w-44">
            <RouterLink
                :to="`/engines/${props.engineId}`"
                class="flex items-center justify-center rounded-md transition-colors text-muted bg-card border border-border w-8 h-8"
            >
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <circle cx="12" cy="12" r="3" />
                    <path
                        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                    />
                </svg>
            </RouterLink>
        </MrTooltip>

        <div class="w-px h-5 bg-border" />

        <MrTooltip text="Add a new module (encoder, decoder, input, output)" width="w-52">
            <MrButton size="sm" @click="emit('toggleAdd')">+ Add Module</MrButton>
        </MrTooltip>
        <MrTooltip text="Zoom to fit this page's modules in view" width="w-44">
            <MrButton size="sm" variant="secondary" @click="emit('fit')">Fit View</MrButton>
        </MrTooltip>
        <MrTooltip
            text="Auto-arrange this page's modules in left-to-right signal-flow order"
            width="w-52"
        >
            <MrButton size="sm" variant="secondary" @click="emit('format')">Format</MrButton>
        </MrTooltip>
        <MrTooltip
            :text="ui.showLogs ? 'Hide engine log viewer' : 'Show engine log viewer'"
            width="w-44"
        >
            <MrButton size="sm" variant="secondary" @click="ui.showLogs = !ui.showLogs"
                >Logs</MrButton
            >
        </MrTooltip>
        <MrTooltip
            :text="
                focusMode
                    ? 'Exit focus mode — show all modules'
                    : 'Enter focus mode — dim non-focused modules'
            "
            width="w-52"
        >
            <MrButton
                size="sm"
                :variant="focusMode ? 'primary' : 'secondary'"
                @click="focusMode = !focusMode"
            >
                Focus
            </MrButton>
        </MrTooltip>

        <MrTooltip
            :text="
                selectMode
                    ? 'Select mode on: drag to box-select, tap modules to add or remove. Right-click the selection for group actions.'
                    : 'Turn on to box-select by dragging. Without it: Shift+drag, or Ctrl/Cmd+click. Right-click the selection for group actions.'
            "
            width="w-60"
        >
            <MrButton
                size="sm"
                :variant="selectMode ? 'primary' : 'secondary'"
                @click="selectMode = !selectMode"
            >
                Select{{ selectedCount > 1 ? ` (${selectedCount})` : '' }}
            </MrButton>
        </MrTooltip>

        <MrTooltip text="Manage interlock (exclusive-mute) groups">
            <MrButton size="sm" variant="secondary" @click="ui.showInterlocks = !ui.showInterlocks">
                Interlocks ({{ engine?.interlocks?.length ?? 0 }})
            </MrButton>
        </MrTooltip>

        <RoutingModuleFinder
            v-model:open="ui.showModuleList"
            :modules="engine?.modules ?? {}"
            @focus-module="(id: string) => emit('focusModule', id)"
        />
    </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
    display: none;
}
.no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
}
.toolbar-h > * {
    height: 32px;
    flex-shrink: 0;
}
.toolbar-h > .w-px {
    height: 20px;
}
</style>

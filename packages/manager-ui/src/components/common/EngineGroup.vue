<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import draggable from 'vuedraggable';
import type { EngineState } from '@/stores/engines';
import type { EngineGroupState } from '@/stores/engineGroups';
import EngineListItem from './EngineListItem.vue';

const props = defineProps<{
    group: EngineGroupState;
    engines: EngineState[];
}>();

const emit = defineEmits<{
    /** Engines were reordered or moved across groups — payload is the new
     * ordered list of engineIds for THIS group. The parent diffs against the
     * server state and posts a bulk reorder update. */
    'engines-change': [groupId: string, engineIds: string[]];
    /** Right-click on an engine row — bubble up so the sidebar shows one menu. */
    'engine-contextmenu': [ev: MouseEvent, engineId: string];
    /** Right-click on the group header. */
    'group-contextmenu': [ev: MouseEvent, groupId: string];
    /** Inline rename — committed name. */
    'rename': [groupId: string, name: string];
    /** Collapsed flag toggled by clicking the chevron. */
    'toggle-collapsed': [groupId: string, collapsed: boolean];
}>();

/**
 * Local mirror of `props.engines` that vuedraggable mutates during a drag.
 * We resync from the prop whenever the server state changes — see watcher.
 * Without this, dragging would try to mutate a read-only computed array.
 */
const localEngines = ref<EngineState[]>([...props.engines]);
watch(
    () => props.engines,
    (next) => {
        // Avoid clobbering mid-drag (the @end handler emits before this fires).
        localEngines.value = [...next];
    },
    { deep: false },
);

function onDragChange() {
    emit(
        'engines-change',
        props.group.id,
        localEngines.value.map((e) => e.engineId),
    );
}

// Inline rename — entered by external request via `requestRename()`.
const renaming = ref(false);
const renameValue = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
// `cancelling` guards against blur firing AFTER Esc — Esc tears down the
// input which loses focus, which would otherwise fire @blur and commit the
// half-typed value the user just abandoned.
let cancelling = false;

function startRename() {
    renameValue.value = props.group.name;
    renaming.value = true;
    cancelling = false;
    nextTick(() => renameInput.value?.focus());
}
function commitRename() {
    if (cancelling) {
        cancelling = false;
        return;
    }
    const v = renameValue.value.trim();
    if (v && v !== props.group.name) {
        emit('rename', props.group.id, v);
    }
    renaming.value = false;
}
function cancelRename() {
    cancelling = true;
    renaming.value = false;
}

defineExpose({ startRename });
</script>

<template>
    <div class="engine-group pt-3 border-t border-border first:border-t-0 first:pt-0">
        <div
            class="group-header flex items-center justify-between px-3 py-1 mb-1 text-muted select-none cursor-pointer"
            @click="emit('toggle-collapsed', group.id, !group.collapsed)"
            @contextmenu.prevent="(ev: MouseEvent) => emit('group-contextmenu', ev, group.id)"
        >
            <div class="flex items-center gap-1.5 flex-1 min-w-0">
                <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="transition-transform shrink-0"
                    :class="group.collapsed ? '-rotate-90' : ''"
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
                <span
                    v-if="group.color"
                    class="w-2 h-2 rounded-full shrink-0"
                    :style="{ backgroundColor: group.color }"
                />
                <input
                    v-if="renaming"
                    ref="renameInput"
                    v-model="renameValue"
                    class="bg-transparent border-b border-border text-[10px] uppercase tracking-wider w-full outline-none"
                    @click.stop
                    @keydown.enter="commitRename"
                    @keydown.esc="cancelRename"
                    @blur="commitRename"
                />
                <span
                    v-else
                    class="text-[10px] font-semibold uppercase tracking-wider truncate"
                >
                    {{ group.name }}
                </span>
            </div>
            <span class="text-[10px] shrink-0 ml-1">{{ engines.length }}</span>
        </div>

        <draggable
            v-show="!group.collapsed"
            v-model="localEngines"
            :group="{ name: 'sidebar-engines' }"
            item-key="engineId"
            class="space-y-0.5 min-h-[4px]"
            ghost-class="opacity-40"
            @change="onDragChange"
        >
            <template #item="{ element: engine }">
                <EngineListItem
                    :engine="engine"
                    @contextmenu="(ev, id) => emit('engine-contextmenu', ev, id)"
                />
            </template>
        </draggable>

        <div
            v-if="!group.collapsed && engines.length === 0"
            class="px-3 py-1 text-[10px] text-muted italic"
        >
            Drop engines here
        </div>
    </div>
</template>

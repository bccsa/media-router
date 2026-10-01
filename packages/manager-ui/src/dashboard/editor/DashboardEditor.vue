<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { Dashboard } from '@media-router/shared-types';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';
import { menuIcons } from '@/utils/moduleMenuItems';
import { getLucideIcon } from '@/composables/useLucideIcons';
import DashboardView from '../DashboardView.vue';
import EditOverlay from './EditOverlay.vue';
import WidgetInspector from './WidgetInspector.vue';
import DashboardSettings from './DashboardSettings.vue';
import DuplicateForDialog from './DuplicateForDialog.vue';
import { WIDGET_LIST } from '../registry';
import { useDraft } from './useDraft';
import type { DashboardSource } from '../source';

/**
 * Edit mode (ADR-0026): a draft with live values, published by Save in one
 * write; Cancel throws it away.
 */
const props = defineProps<{
    dashboard: Dashboard;
    source: DashboardSource;
    /** A manager dashboard: pickers start at the router. */
    pickRouter?: boolean;
    saving?: boolean;
    error?: string;
}>();
/** `baseRev`: the revision this edit started from, for the conflict check. */
const emit = defineEmits<{ save: [dashboard: Dashboard, baseRev: number]; cancel: [] }>();

const d = useDraft(props.dashboard);
const baseRev = props.dashboard.rev ?? 0;
const settingsOpen = ref(false);
const duplicating = ref(false);
const discarding = ref(false);
const menuAt = ref<{ x: number; y: number } | null>(null);
const menuItems = () => {
    const n = d.selected.value.length;
    return [{ label: n > 1 ? `Delete ${n} widgets` : 'Delete', action: 'delete', danger: true, icon: menuIcons.delete }];
};
function onMenu(action: string) {
    if (action === 'delete') d.remove();
    menuAt.value = null;
}

function cancel() {
    if (d.dirty.value) discarding.value = true;
    else emit('cancel');
}

function typing(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

const MOVES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function onKey(e: KeyboardEvent) {
    if (typing(e) || settingsOpen.value || duplicating.value) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') d.remove();
    else if (mod && e.key.toLowerCase() === 'c') d.copy();
    else if (mod && e.key.toLowerCase() === 'v') d.paste();
    else if (e.key === 'Escape') d.select(null);
    else if (MOVES[e.key]) d.move(...MOVES[e.key]);
    else return;
    e.preventDefault();
}
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
    <div class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
            <span class="font-semibold text-foreground truncate">{{ d.draft.value.name }}</span>
            <span class="text-xs text-muted">{{ d.draft.value.cols }} × {{ d.draft.value.rows }}</span>
            <MrButton size="sm" variant="secondary" @click="settingsOpen = true">Settings</MrButton>
            <MrButton size="sm" variant="secondary" :disabled="d.selection.value.length === 0" @click="d.copy()">Copy</MrButton>
            <MrButton size="sm" variant="secondary" @click="d.paste()">Paste</MrButton>
            <div class="flex-1" />
            <span v-if="error" class="text-xs text-red-400 truncate max-w-md">{{ error }}</span>
            <MrButton size="sm" variant="secondary" @click="cancel">Cancel</MrButton>
            <MrButton size="sm" :loading="saving" :disabled="!d.dirty.value" @click="emit('save', d.draft.value, baseRev)">Save</MrButton>
        </div>

        <div class="flex flex-1 min-h-0">
            <aside class="w-44 shrink-0 border-r border-border bg-card overflow-auto p-2 space-y-1">
                <div class="text-[11px] uppercase tracking-wide text-muted px-1 pb-1">Add widget</div>
                <button
                    v-for="w in WIDGET_LIST"
                    :key="w.type"
                    class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent-muted"
                    @click="d.add(w.type)"
                >
                    <component :is="getLucideIcon(w.icon)" :size="16" />
                    {{ w.label }}
                </button>
            </aside>

            <div class="relative flex-1 min-w-0">
                <DashboardView :dashboard="d.draft.value" :source="source" editing>
                    <template #overlay="{ metrics }">
                        <EditOverlay :draft="d" :metrics="metrics" @menu="(x, y) => (menuAt = { x, y })" />
                    </template>
                </DashboardView>
            </div>

            <aside class="w-72 shrink-0 border-l border-border bg-card overflow-auto p-3">
                <WidgetInspector :draft="d" :source="source" :pick-router="pickRouter" @duplicate-for="duplicating = true" />
            </aside>
        </div>

        <DashboardSettings v-if="settingsOpen" :settings="d.draft.value" @apply="(p) => { d.configure(p); settingsOpen = false; }" @close="settingsOpen = false" />
        <DuplicateForDialog
            v-if="duplicating && d.selectionModule.value"
            :source="source"
            :from-module="d.selectionModule.value"
            :pick-router="pickRouter"
            @pick="(to) => { d.duplicateFor(to); duplicating = false; }"
            @close="duplicating = false"
        />
        <MrContextMenu v-if="menuAt" :items="menuItems()" :x="menuAt.x" :y="menuAt.y" @action="onMenu" @close="menuAt = null" />
        <MrModal v-if="discarding" title="Discard changes?" @close="discarding = false">
            <p class="text-sm text-subtle">Your edits to this dashboard have not been saved.</p>
            <template #footer>
                <MrButton variant="secondary" @click="discarding = false">Keep editing</MrButton>
                <MrButton variant="danger" @click="emit('cancel')">Discard</MrButton>
            </template>
        </MrModal>
    </div>
</template>

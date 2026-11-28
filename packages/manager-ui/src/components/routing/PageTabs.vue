<script setup lang="ts">
/**
 * The routing editor's page tabs (ADR-0030), a strip under the canvas: pick a
 * page, add one, rename it (double-click, or right-click / long-press →
 * Rename), reorder and delete it. Props in, emits out. Names are checked live
 * with the rule the manager applies; ids are never shown.
 */
import { ref, computed, nextTick, watch } from 'vue';
// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import MrInput from '@/components/common/MrInput.vue';
import MrContextMenu, { type MenuItem } from '@/components/common/MrContextMenu.vue';
import PageDeleteDialog from './PageDeleteDialog.vue';
import { useLongPress } from '@/composables/useLongPress';
import { menuIcons } from '@/utils/moduleMenuItems';
import type { PageTab, PageTabsEmits, PageTabsProps } from '../../utils/crossRefTypes';

const { pageNameError } = shared;

const props = defineProps<PageTabsProps>();
const emit = defineEmits<PageTabsEmits>();

function select(tab: PageTab) {
    if (tab.id !== props.currentId) emit('select', tab.id);
}

// --- Rename in place: Enter or leaving the box commits a valid name, Escape cancels.
const editingId = ref<string | null>(null);
const draft = ref('');
let editBox: HTMLElement | null = null;
const setEditBox = (el: unknown) => (editBox = el as HTMLElement | null);

const renameError = computed(() => {
    if (!editingId.value) return null;
    const others = props.pages.filter((p) => p.id !== editingId.value).map((p) => p.name);
    return pageNameError(draft.value, others);
});

function startRename(tab: PageTab) {
    editingId.value = tab.id;
    draft.value = tab.name;
    nextTick(() => {
        const input = editBox?.querySelector('input');
        input?.focus();
        input?.select();
    });
}

function commitRename() {
    const tab = props.pages.find((p) => p.id === editingId.value);
    if (renameError.value) return;
    editingId.value = null;
    const name = draft.value.trim();
    if (tab && name !== tab.name) emit('rename', tab.id, name);
}

// Leaving the box with a name that can't be used drops it.
function onRenameBlur() {
    if (renameError.value) editingId.value = null;
    else commitRename();
}

// --- Delete: asks which page takes its modules.
const deleting = ref<PageTab | null>(null);
function confirmDelete(targetId: string) {
    if (deleting.value) emit('delete', deleting.value.id, targetId);
    deleting.value = null;
}

// --- Tab menu: right-click, or a long press on touch.
const menu = ref<{ id: string; x: number; y: number } | null>(null);
let pressedId: string | null = null;
const longPress = useLongPress((e) => {
    const t = e.touches[0] ?? e.changedTouches[0];
    if (pressedId) menu.value = { id: pressedId, x: t?.clientX ?? 0, y: t?.clientY ?? 0 };
});
function onTouchStart(e: TouchEvent, tab: PageTab) {
    pressedId = tab.id;
    longPress.onTouchStart(e);
}
function onContextMenu(e: MouseEvent, tab: PageTab) {
    menu.value = { id: tab.id, x: e.clientX, y: e.clientY };
}

const menuItems = computed<MenuItem[]>(() => {
    const i = props.pages.findIndex((p) => p.id === menu.value?.id);
    const only = props.pages.length <= 1;
    return [
        { label: 'Rename', action: 'rename', icon: menuIcons.editLabel },
        { label: 'Move left', action: 'left', disabled: i <= 0 },
        { label: 'Move right', action: 'right', disabled: i < 0 || i >= props.pages.length - 1 },
        { label: '', action: '', divider: true },
        {
            label: 'Delete…',
            action: 'delete',
            icon: menuIcons.delete,
            danger: true,
            disabled: only,
            tooltip: only ? 'The only page cannot be deleted' : undefined,
        },
    ];
});

function onMenuAction(action: string) {
    const tab = props.pages.find((p) => p.id === menu.value?.id);
    if (!tab) return;
    if (action === 'rename') startRename(tab);
    else if (action === 'left') emit('move', tab.id, -1);
    else if (action === 'right') emit('move', tab.id, 1);
    else if (action === 'delete') deleting.value = tab;
}

// Keep the current tab in view when it changes (a jump to a tag on another page).
const strip = ref<HTMLElement | null>(null);
watch(
    () => props.currentId,
    (id) =>
        nextTick(() => {
            const tabs = [...(strip.value?.children ?? [])] as HTMLElement[];
            tabs.find((el) => el.dataset.page === id)?.scrollIntoView?.({
                block: 'nearest',
                inline: 'nearest',
            });
        }),
);
</script>

<template>
    <div class="shrink-0 flex items-start border-t border-border bg-card select-none">
        <div ref="strip" role="tablist" class="flex-1 min-w-0 flex items-start overflow-x-auto">
            <div
                v-for="tab in pages"
                :key="tab.id"
                :data-page="tab.id"
                class="shrink-0 border-r border-border-alt"
            >
                <div v-if="editingId === tab.id" :ref="setEditBox" class="w-48 px-1.5 py-1">
                    <MrInput
                        v-model="draft"
                        :error="renameError ?? undefined"
                        @keydown.enter="commitRename"
                        @keydown.esc="editingId = null"
                        @focusout="onRenameBlur"
                    />
                </div>
                <button
                    v-else
                    role="tab"
                    data-test="tab"
                    :aria-selected="tab.id === currentId"
                    class="flex items-center gap-1.5 h-8 px-3 text-xs whitespace-nowrap border-t-2 transition-colors"
                    :class="
                        tab.id === currentId
                            ? 'border-accent bg-surface text-foreground font-medium'
                            : 'border-transparent text-muted hover:text-foreground'
                    "
                    @click="select(tab)"
                    @dblclick="startRename(tab)"
                    @contextmenu.prevent="onContextMenu($event, tab)"
                    @touchstart.passive="onTouchStart($event, tab)"
                    @touchend.passive="longPress.onTouchEnd"
                    @touchmove.passive="longPress.onTouchMove"
                >
                    <span>{{ tab.name }}</span>
                    <span data-test="count" class="text-[10px] text-muted">{{
                        tab.moduleCount
                    }}</span>
                </button>
            </div>
        </div>
        <button
            data-test="add"
            aria-label="Add page"
            class="shrink-0 h-8 w-8 flex items-center justify-center text-muted hover:text-foreground"
            @click="emit('add')"
        >
            <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M12 5v14M5 12h14" />
            </svg>
        </button>

        <MrContextMenu
            v-if="menu"
            :items="menuItems"
            :x="menu.x"
            :y="menu.y"
            @action="onMenuAction"
            @close="menu = null"
        />
        <PageDeleteDialog
            v-if="deleting"
            :page="deleting"
            :pages="pages"
            @confirm="confirmDelete"
            @close="deleting = null"
        />
    </div>
</template>

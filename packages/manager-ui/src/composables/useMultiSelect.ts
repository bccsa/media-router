import { ref, computed, watch, getCurrentInstance, onMounted, onUnmounted, type ComputedRef, type Ref } from 'vue';
import { useVueFlow } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { useLongPress } from '@/composables/useLongPress';

/** Modules and loose connections awaiting delete confirmation. */
export interface PendingDelete {
    modules: string[];
    edges: string[];
}

export interface MultiSelectOptions {
    engineId: () => string;
    engine: ComputedRef<EngineState | undefined>;
    /** Canvas root; the Delete key only acts while focus is inside it (or nowhere). */
    container: Ref<HTMLElement | null>;
    /** True while a panel, menu or dialog is open — keys are left alone. */
    isBlocked: () => boolean;
    onEdgeDelete: (edgeId: string) => void;
    /** Long-press on the selection rectangle (touch has no right-click). */
    openGroupMenu: (moduleIds: string[], x: number, y: number) => void;
}

function isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el) return false;
    return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName ?? '');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Canvas multi-selection. Default gestures: Shift+drag box, Ctrl/Cmd+click.
 * Select mode (toolbar, touch): plain drag draws the box, tap toggles a node.
 */
export function useMultiSelect(opts: MultiSelectOptions) {
    const { getSelectedNodes, getSelectedEdges, removeSelectedElements } = useVueFlow();

    const selectMode = ref(false);
    const selectedCount = computed(() => getSelectedNodes.value.length);
    const pendingDelete = ref<PendingDelete | null>(null);

    // Leaving select mode drops the selection so nothing stays highlighted.
    watch(selectMode, (on) => {
        if (!on) removeSelectedElements();
    });

    function selectedNodeIds(): string[] {
        return getSelectedNodes.value.map((n) => n.id);
    }

    function requestDelete(modules: string[], edges: string[] = []) {
        if (modules.length || edges.length) pendingDelete.value = { modules, edges };
    }

    function confirmDelete() {
        const p = pendingDelete.value;
        pendingDelete.value = null;
        if (!p) return;
        for (const id of p.edges) opts.onEdgeDelete(id);
        if (p.modules.length) patch.removeModules(opts.engineId(), p.modules);
        removeSelectedElements();
    }

    const deleteTitle = computed(() => {
        const p = pendingDelete.value;
        if (!p) return '';
        const { modules, edges } = p;
        if (modules.length === 1 && edges.length === 0) {
            const name = opts.engine.value?.modules[modules[0]]?.displayName ?? 'module';
            return `Delete ${name}?`;
        }
        const parts = [];
        if (modules.length) parts.push(plural(modules.length, 'module', 'modules'));
        if (edges.length) parts.push(plural(edges.length, 'connection', 'connections'));
        return `Delete ${parts.join(' and ')}?`;
    });

    const deleteMessage = computed(() => {
        const p = pendingDelete.value;
        if (!p) return '';
        if (p.modules.length === 0)
            return p.edges.length === 1
                ? 'The connection will be removed.'
                : 'The connections will be removed.';
        return p.modules.length === 1
            ? 'The module and all its connections will be removed permanently.'
            : 'The modules and all their connections will be removed permanently.';
    });

    /** Keys belong to the canvas only when nothing else has focus. */
    function canvasOwnsKeys(e: KeyboardEvent): boolean {
        if (opts.isBlocked() || isTypingTarget(e.target)) return false;
        const active = document.activeElement;
        if (!active || active === document.body) return true;
        return !!opts.container.value?.querySelector('.vue-flow')?.contains(active);
    }

    function onKeydown(e: KeyboardEvent) {
        if (pendingDelete.value || !canvasOwnsKeys(e)) return;
        if (e.key === 'Escape') {
            removeSelectedElements();
            return;
        }
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        const modules = selectedNodeIds();
        const gone = new Set(modules);
        // Edges on a deleted module go with it; only loose ones are listed.
        const edges = getSelectedEdges.value
            .filter((edge) => !gone.has(edge.source) && !gone.has(edge.target))
            .map((edge) => edge.id);
        if (modules.length === 0 && edges.length === 0) return;
        e.preventDefault();
        requestDelete(modules, edges);
    }

    // Capture phase: Vue Flow's drag handler stops touchstart propagation.
    const longPress = useLongPress((e) => {
        const t = e.touches[0] ?? e.changedTouches[0];
        const ids = selectedNodeIds();
        if (t && ids.length > 1) opts.openGroupMenu(ids, t.clientX, t.clientY);
    });
    function onTouchStartCapture(e: TouchEvent) {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.('.vue-flow__nodesselection-rect')) longPress.onTouchStart(e);
    }

    // Touch listeners go on the element captured at mount; the ref is null by unmount.
    let bound: HTMLElement | null = null;
    const touchOpts = { capture: true, passive: true } as const;
    if (getCurrentInstance()) {
        onMounted(() => {
            // Capture: runs before MrModal's Escape closes the confirm.
            window.addEventListener('keydown', onKeydown, true);
            bound = opts.container.value;
            bound?.addEventListener('touchstart', onTouchStartCapture, touchOpts);
            bound?.addEventListener('touchmove', longPress.onTouchMove, touchOpts);
            bound?.addEventListener('touchend', longPress.onTouchEnd, touchOpts);
        });
        onUnmounted(() => {
            window.removeEventListener('keydown', onKeydown, true);
            bound?.removeEventListener('touchstart', onTouchStartCapture, touchOpts);
            bound?.removeEventListener('touchmove', longPress.onTouchMove, touchOpts);
            bound?.removeEventListener('touchend', longPress.onTouchEnd, touchOpts);
            bound = null;
        });
    }

    return {
        selectMode,
        selectedCount,
        selectedNodeIds,
        pendingDelete,
        deleteTitle,
        deleteMessage,
        requestDelete,
        confirmDelete,
        onKeydown,
    };
}

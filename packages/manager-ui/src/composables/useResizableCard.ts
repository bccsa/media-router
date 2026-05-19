import { computed, ref, watch, type Ref } from 'vue';
import { useVueFlow } from '@vue-flow/core';
import type { ResizableBounds } from '@media-router/shared-types';

const DEFAULT_WIDTH = 200;
const DEFAULT_BOUNDS: Required<ResizableBounds> = {
    minWidth: 160,
    minHeight: 80,
    maxWidth: 600,
    maxHeight: 600,
};

export interface ResizableCardOptions {
    /** Module instance id — used to nudge Vue Flow's edge anchors after a resize. */
    moduleId: Ref<string>;
    /** Plugin's `resizable` manifest field. Truthy = enabled; object = custom bounds. */
    resizable: Ref<boolean | ResizableBounds | undefined>;
    /** Stored per-instance size (replicated via the N-1 patch router). */
    storedSize: Ref<{ width?: number; height?: number } | undefined>;
    /** Larger of input vs output port count — feeds the non-resizable minimum height. */
    portCount: Ref<number>;
    /** Persistence callback fired once at drag end with the final size. */
    onPersist: (size: { width: number; height: number }) => void;
}

/**
 * Card resize machinery for `ModuleNode.vue`.
 *
 * Drag-grip mouse/touch handlers, optimistic local size during drag, and
 * Vue Flow `updateNodeInternals` nudges so edge anchors follow live. Falls
 * back to a non-resizable, content-driven height when the plugin opts out.
 */
export function useResizableCard(opts: ResizableCardOptions) {
    const { updateNodeInternals } = useVueFlow();
    // Optimistic local override while the user drags — replaces the stored size
    // until drag-end persists. Falls back to the stored size, then the default.
    const dragSize = ref<{ width: number; height: number } | null>(null);

    const resizable = computed(() => !!opts.resizable.value);
    const bounds = computed<Required<ResizableBounds>>(() => {
        const r = opts.resizable.value;
        const custom = typeof r === 'object' && r !== null ? r : {};
        return { ...DEFAULT_BOUNDS, ...custom };
    });
    const cardWidth = computed(
        () => dragSize.value?.width ?? opts.storedSize.value?.width ?? DEFAULT_WIDTH,
    );
    const cardHeight = computed(() => {
        if (dragSize.value) return dragSize.value.height;
        if (opts.storedSize.value?.height != null) return opts.storedSize.value.height;
        // Resizable plugins need an explicit starting height so the card isn't
        // content-driven. Without it, text-size changes (e.g. the note plugin's
        // auto-fit) silently grow the card. Fall back to the manifest's minHeight.
        return resizable.value ? bounds.value.minHeight : undefined;
    });
    /** Non-resizable floor — leaves enough vertical space for the declared ports. */
    const cardMinHeight = computed(() => 36 + Math.max(opts.portCount.value, 1) * 24 + 8);

    // When the stored size changes (e.g. patched from another browser), tell
    // Vue Flow to re-measure so edge anchors follow.
    watch(
        () => [opts.storedSize.value?.width, opts.storedSize.value?.height],
        () => updateNodeInternals([opts.moduleId.value]),
    );

    function clamp(n: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, n));
    }

    function onResizeStart(event: MouseEvent | TouchEvent): void {
        const startX = 'touches' in event ? event.touches[0].clientX : event.clientX;
        const startY = 'touches' in event ? event.touches[0].clientY : event.clientY;
        const startW = cardWidth.value;
        const startH = cardHeight.value ?? cardMinHeight.value;
        const b = bounds.value;

        const move = (e: MouseEvent | TouchEvent): void => {
            const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
            dragSize.value = {
                width: clamp(startW + (cx - startX), b.minWidth, b.maxWidth),
                height: clamp(startH + (cy - startY), b.minHeight, b.maxHeight),
            };
            // Nudge Vue Flow so edge anchor points follow the resized node live.
            updateNodeInternals([opts.moduleId.value]);
        };
        const end = (): void => {
            const final = dragSize.value;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', end);
            window.removeEventListener('touchmove', move);
            window.removeEventListener('touchend', end);
            // The persistence callback applies optimistically (synchronous), so by
            // the time we clear `dragSize`, props.size already matches `final` —
            // cardWidth/cardHeight fall through to the stored size, no snap-back.
            if (final) opts.onPersist(final);
            dragSize.value = null;
            updateNodeInternals([opts.moduleId.value]);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', end);
    }

    return { resizable, bounds, cardWidth, cardHeight, cardMinHeight, onResizeStart };
}

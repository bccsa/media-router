<script setup lang="ts">
import { computed, ref } from 'vue';
import { rectOf, type GridMetrics } from '../grid';
import type { Draft } from './useDraft';

const props = defineProps<{ draft: Draft; metrics: GridMetrics }>();
/** Right click on a widget: its menu, for the selection it is in (or it alone). */
const emit = defineEmits<{ menu: [x: number, y: number] }>();

type Drag = { kind: 'move' | 'resize'; id: string; x0: number; y0: number; applied: { x: number; y: number }; w0: number; h0: number };
const drag = ref<Drag | null>(null);
const single = computed(() => (props.draft.selected.value.length === 1 ? props.draft.selected.value[0] : null));

function down(id: string, e: PointerEvent, kind: Drag['kind']) {
    e.stopPropagation();
    const extend = e.shiftKey || e.ctrlKey || e.metaKey;
    if (kind === 'move' && (extend || !props.draft.selected.value.includes(id))) props.draft.select(id, extend);
    if (extend) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const w = props.draft.draft.value.widgets.find((x) => x.id === id)!;
    drag.value = { kind, id, x0: e.clientX, y0: e.clientY, applied: { x: 0, y: 0 }, w0: w.w, h0: w.h };
}

function move(e: PointerEvent) {
    const d = drag.value;
    if (!d) return;
    const dx = Math.round((e.clientX - d.x0) / props.metrics.cw);
    const dy = Math.round((e.clientY - d.y0) / props.metrics.ch);
    if (d.kind === 'resize') {
        props.draft.resize(d.id, d.w0 + dx, d.h0 + dy);
    } else if (dx !== d.applied.x || dy !== d.applied.y) {
        props.draft.move(dx - d.applied.x, dy - d.applied.y);
        d.applied = { x: dx, y: dy };
    }
}

function menu(id: string, e: MouseEvent) {
    if (!props.draft.selected.value.includes(id)) props.draft.select(id, false);
    emit('menu', e.clientX, e.clientY);
}

const style = (r: ReturnType<typeof rectOf>) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
</script>

<template>
    <div class="eo" :style="{ width: `${metrics.width}px`, height: `${metrics.height}px` }" @pointerdown.self="draft.select(null)">
        <div
            v-for="w in draft.draft.value.widgets"
            :key="w.id"
            class="eo-box"
            :class="{ 'eo-sel': draft.selected.value.includes(w.id) }"
            :style="style(rectOf(w, metrics))"
            @pointerdown="$event.button === 0 && down(w.id, $event, 'move')"
            @contextmenu.prevent="menu(w.id, $event)"
            @pointermove="move"
            @pointerup="drag = null"
            @pointercancel="drag = null"
        >
            <div
                v-if="single === w.id"
                class="eo-handle"
                @pointerdown="down(w.id, $event, 'resize')"
                @pointermove.stop="move"
                @pointerup.stop="drag = null"
            />
        </div>
    </div>
</template>

<style scoped>
.eo {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 5;
    background-image:
        linear-gradient(to right, rgba(148, 163, 184, 0.12) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(148, 163, 184, 0.12) 1px, transparent 1px);
    background-size: v-bind('`${metrics.cw}px ${metrics.ch}px`');
}
.eo-box {
    position: absolute;
    box-sizing: border-box;
    border: 1px dashed rgba(148, 163, 184, 0.35);
    border-radius: 8px;
    cursor: move;
    touch-action: none;
}
.eo-sel {
    border: 2px solid var(--d-accent);
    background: color-mix(in srgb, var(--d-accent) 8%, transparent);
}
.eo-handle {
    position: absolute;
    right: -6px;
    bottom: -6px;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: var(--d-accent);
    cursor: nwse-resize;
}
</style>

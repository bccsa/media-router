<script lang="ts">
/**
 * A click waits this long before it opens the dropdown, so the two clicks of a
 * double-click open only the side panel. A slower double-click can still open
 * the dropdown first: the parent should close it when `settings` arrives.
 */
export const XREF_DBLCLICK_MS = 250;
</script>

<script setup lang="ts">
/**
 * A cross-reference tag on the routing canvas (ADR-0030): a rectangle with a
 * point on the right, filled by the feed's stream type, grey when read-only.
 * Its handle is not connectable, so wires never start from or snap onto it.
 */
import { computed, onUnmounted } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import { XREF_HANDLE_ID, type XrefNodeData, type XrefNodeEmits } from '@/utils/crossRefTypes';
import { TAG_SIZE } from '@/utils/xrefCanvas';

const props = defineProps<{ id: string; data: XrefNodeData }>();
const emit = defineEmits<XrefNodeEmits>();

/** Width of the point, px. */
const POINT = 10;
const HIGHLIGHT = 'drop-shadow(0 0 2px #fff) drop-shadow(0 0 6px var(--accent))';

const tag = computed(() => props.data.ref);
// `color` comes resolved from deriveRefs: the feed's colour, grey when read-only.
const ink = computed(() => inkOn(tag.value.color));
const kindLabel = computed(() => (tag.value.kind === 'out' ? 'Output' : 'Input'));

/** Dark text on light fills (cyan, amber), white on dark ones (grey): WCAG luminance crossover. */
function inkOn(color: string): string {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    if (!m) return '#ffffff';
    const [r, g, b] = m.slice(1).map((h) => {
        const c = parseInt(h, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#0f1117' : '#ffffff';
}

let pending: ReturnType<typeof setTimeout> | null = null;
function cancelPending() {
    if (pending) clearTimeout(pending);
    pending = null;
}
onUnmounted(cancelPending);

function onClick(e: MouseEvent) {
    cancelPending();
    // The second click of a double-click: dblclick follows and opens settings.
    if (e.detail > 1) return;
    const { clientX, clientY } = e;
    pending = setTimeout(() => {
        pending = null;
        emit('open', tag.value.key, clientX, clientY);
    }, XREF_DBLCLICK_MS);
}

function onDblClick() {
    cancelPending();
    emit('settings', tag.value.key);
}
</script>

<template>
    <div
        class="relative cursor-pointer select-none transition-[opacity] duration-200 ease-in-out"
        :class="{ 'animate-pulse': data.highlighted }"
        :style="{
            opacity: data.dimmed ? 0.15 : 1,
            filter: data.highlighted ? HIGHLIGHT : undefined,
        }"
        role="button"
        :aria-label="`${kindLabel} reference ${tag.label} ${tag.hint}`"
        :data-kind="tag.kind"
        @click="onClick"
        @dblclick="onDblClick"
    >
        <!-- Body and point in one SVG: the nested svg sits at the body's right
             edge and stretches the point to the body's height. -->
        <svg
            class="absolute inset-y-0 left-0 h-full overflow-visible"
            :style="{ width: `calc(100% - ${POINT}px)` }"
            aria-hidden="true"
        >
            <rect data-test="body" width="100%" height="100%" :fill="tag.color" />
            <svg
                x="100%"
                :width="POINT"
                height="100%"
                viewBox="0 0 10 20"
                preserveAspectRatio="none"
                overflow="visible"
            >
                <!-- Starts 1px inside the body so no seam shows. -->
                <polygon data-test="point" points="-1,0 10,10 -1,20" :fill="tag.color" />
            </svg>
        </svg>

        <!-- One row, TAG_SIZE.height tall: tags beside neighbouring ports don't overlap. -->
        <div
            data-test="face"
            class="relative flex items-center gap-1 pl-2 leading-none whitespace-nowrap"
            :style="{ color: ink, height: `${TAG_SIZE.height}px`, paddingRight: `${POINT + 6}px` }"
        >
            <span data-test="label" class="text-[11px] font-semibold">{{ tag.label }}</span>
            <span v-if="tag.capacity === -1" data-test="unlimited" class="text-[9px] opacity-60"
                >&#8734;</span
            >
            <span data-test="hint" class="ml-0.5 text-[9px] opacity-80">{{ tag.hint }}</span>
        </div>

        <!-- Output tag: the wire arrives from the module output on the left.
             Input tag: it leaves from the point towards the module input. -->
        <Handle
            :id="XREF_HANDLE_ID"
            :type="tag.kind === 'out' ? 'target' : 'source'"
            :position="tag.kind === 'out' ? Position.Left : Position.Right"
            :connectable="false"
            class="!w-1.5 !h-1.5 !min-w-0 !min-h-0 !border-0 !bg-transparent"
        />
    </div>
</template>

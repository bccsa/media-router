<script setup lang="ts">
/**
 * "?" help popover for a settings field.
 *
 * Hover or keyboard focus opens it; click/tap (or Enter/Space) pins it so
 * touch screens without hover can read it; Escape, blur or a tap anywhere
 * else closes it. The bubble is teleported to <body> and positioned `fixed`
 * from the trigger's rect, so a scroll box never clips it, and it flips above
 * the trigger when there is no room below. It is kept invisible until placed
 * and re-placed on scroll/resize, so it never flashes or detaches. One set of
 * document listeners serves every open tip (a settings panel mounts dozens).
 * The default slot replaces the trigger (the ⚡ live badge uses this);
 * without a slot the circle-help icon renders.
 */
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { TOOLTIP_BUBBLE_CLASS } from './tooltipBubble';

defineProps<{
    text: string;
    /** Tailwind width class for the bubble (default `w-64`). */
    width?: string;
}>();

interface OpenTip {
    trigger: () => HTMLElement | null;
    pinned: () => boolean;
    place: () => void;
    close: () => void;
}

/** Every currently open tip; document listeners exist only while non-empty. */
const openTips = new Set<OpenTip>();

function onDocumentPointer(e: Event): void {
    for (const tip of openTips) {
        if (tip.pinned() && !tip.trigger()?.contains(e.target as Node)) tip.close();
    }
}
function onDocumentKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    for (const tip of openTips) tip.close();
}
function onViewportMove(): void {
    for (const tip of openTips) tip.place();
}

function track(tip: OpenTip): void {
    if (openTips.size === 0) {
        document.addEventListener('pointerdown', onDocumentPointer);
        document.addEventListener('keydown', onDocumentKey);
        document.addEventListener('scroll', onViewportMove, { capture: true, passive: true });
        window.addEventListener('resize', onViewportMove, { passive: true });
    }
    openTips.add(tip);
}
function untrack(tip: OpenTip): void {
    openTips.delete(tip);
    if (openTips.size === 0) {
        document.removeEventListener('pointerdown', onDocumentPointer);
        document.removeEventListener('keydown', onDocumentKey);
        document.removeEventListener('scroll', onViewportMove, { capture: true });
        window.removeEventListener('resize', onViewportMove);
    }
}

let seq = 0;
const bubbleId = `mr-help-tip-${++seq}`;

const open = ref(false);
const pinned = ref(false);
const placed = ref(false);
const trigger = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const pos = ref<Record<string, string>>({});

const EDGE = 8;
const GAP = 4;

function place(): void {
    const t = trigger.value?.getBoundingClientRect();
    const b = bubble.value?.getBoundingClientRect();
    if (!t || !b) return;
    let left = t.left;
    if (left + b.width + EDGE > window.innerWidth) {
        left = Math.max(EDGE, window.innerWidth - b.width - EDGE);
    }
    let top = t.bottom + GAP;
    if (top + b.height + EDGE > window.innerHeight) {
        top = Math.max(EDGE, t.top - GAP - b.height);
    }
    pos.value = { left: `${left}px`, top: `${top}px` };
    placed.value = true;
}

const self: OpenTip = {
    trigger: () => trigger.value,
    pinned: () => pinned.value,
    place,
    close,
};

function show(): void {
    if (open.value) return;
    placed.value = false;
    open.value = true;
    track(self);
    // The bubble exists only after this tick; it stays invisible until placed.
    void nextTick(place);
}

function hide(): void {
    if (!pinned.value) close();
}

function close(): void {
    pinned.value = false;
    if (!open.value) return;
    open.value = false;
    untrack(self);
}

function toggle(): void {
    if (pinned.value) close();
    else {
        pinned.value = true;
        show();
    }
}

onBeforeUnmount(close);
</script>

<template>
    <span
        ref="trigger"
        class="inline-flex items-center cursor-help outline-none"
        tabindex="0"
        role="button"
        aria-label="Help"
        :aria-expanded="pinned"
        :aria-describedby="open ? bubbleId : undefined"
        @mouseenter="show"
        @mouseleave="hide"
        @focus="show"
        @blur="close"
        @click.stop.prevent="toggle"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
    >
        <slot>
            <!-- lucide `circle-help`, inlined so the trigger never waits on an async chunk -->
            <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="text-muted hover:text-foreground transition-colors"
                :class="{ 'text-foreground': open }"
            >
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <path d="M12 17h.01" />
            </svg>
        </slot>
    </span>
    <Teleport to="body">
        <div
            v-if="open"
            :id="bubbleId"
            ref="bubble"
            role="tooltip"
            class="fixed text-[11px] whitespace-normal"
            :class="[TOOLTIP_BUBBLE_CLASS, width ?? 'w-64']"
            :style="{ zIndex: 9999, visibility: placed ? 'visible' : 'hidden', ...pos }"
        >
            {{ text }}
        </div>
    </Teleport>
</template>

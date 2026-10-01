<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WidgetProps } from '../../registry';
import { useTimed } from '../../useTimed';
import { debounced, dragValue, fraction, throttled } from '../../drag';
import { asNumber, clampNumber, formatValue, hasRange, stepDecimals } from '../../valueTypes';

// Fader (vertical) and slider (horizontal): grab and drag, no jump on touch.
const props = defineProps<WidgetProps & { vertical?: boolean }>();
const emit = defineEmits<{ write: [value: number] }>();

const vertical = computed(() => !!props.vertical);
const track = ref<HTMLElement | null>(null);
const dragging = ref(false);
/** After release, show the dragged value until the stored one catches up (at most 1.5 s). */
const { value: holding, set: hold } = useTimed(false, 1500);
const local = ref(0);
let start = { pos: 0, value: 0 };
/** A grab only writes once it has actually moved. */
let moved = false;
const write = (v: number) => emit('write', v);
/** ≤ one write per 100 ms while dragging, or only once it rests when the value asks (`x-debounceMs`). */
let send = throttled(write, 100);

// Its value's range comes from /meta; without one it takes no input and says so.
const ranged = computed(() => !!props.desc && hasRange(props.desc));
const live = computed(() => props.interactive && ranged.value);
const min = computed(() => props.desc?.min ?? 0);
const max = computed(() => props.desc?.max ?? 100);
const step = computed(() => Number(props.options.step) || props.desc?.step);
const stored = computed(() => asNumber(props.value) ?? min.value);
const current = computed(() => (dragging.value || holding.value ? local.value : stored.value));
const frac = computed(() => fraction(current.value, min.value, max.value));
const text = computed(() =>
    ranged.value
        ? formatValue(current.value, stepDecimals(step.value), props.options.showUnit ? props.desc?.unit : undefined)
        : props.desc
          ? 'No range'
          : '—',
);
const accent = computed(() => props.options.accent || 'var(--d-accent)');

watch(stored, (v) => {
    if (holding.value && v === local.value) hold(false);
});

const along = (e: PointerEvent) => (vertical.value ? -e.clientY : e.clientX);
function length(): number {
    const r = track.value?.getBoundingClientRect();
    return (vertical.value ? r?.height : r?.width) || 1;
}

function down(e: PointerEvent) {
    if (!live.value) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    // Read the value before `dragging` flips `current` over to the local copy.
    start = { pos: along(e), value: current.value };
    const rest = props.desc?.debounceMs ?? 0;
    send = rest > 0 ? debounced(write, rest) : throttled(write, 100);
    local.value = start.value;
    moved = false;
    dragging.value = true;
}

function move(e: PointerEvent) {
    if (!dragging.value) return;
    const next = dragValue(start.value, along(e) - start.pos, length(), min.value, max.value, step.value);
    if (!moved && next === start.value) return;
    moved = true;
    local.value = next;
    send.push(next);
}

function up() {
    if (!dragging.value) return;
    dragging.value = false;
    if (!moved) return;
    send.end(local.value);
    hold(local.value !== stored.value);
}

/** Keys: arrows by a step (1 % of the range without one), Page keys by ten, Home/End to the ends. */
function key(e: KeyboardEvent) {
    if (!live.value) return;
    const unit = step.value || (max.value - min.value) / 100;
    const by: Record<string, number> = { ArrowUp: unit, ArrowRight: unit, ArrowDown: -unit, ArrowLeft: -unit, PageUp: unit * 10, PageDown: -unit * 10 };
    let next: number;
    if (e.key === 'Home') next = min.value;
    else if (e.key === 'End') next = max.value;
    else if (e.key in by) next = clampNumber(stored.value + by[e.key], min.value, max.value);
    else return;
    e.preventDefault();
    if (next !== stored.value) emit('write', next);
}

</script>

<template>
    <div
        class="lc"
        :class="[vertical ? 'lc-v' : 'lc-h', { 'lc-live': live }]"
        role="slider"
        :aria-label="label"
        :aria-orientation="vertical ? 'vertical' : 'horizontal'"
        :aria-valuemin="min"
        :aria-valuemax="max"
        :aria-valuenow="current"
        :aria-valuetext="text"
        :aria-disabled="!live"
        :tabindex="live ? 0 : -1"
        @keydown="key"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
    >
        <div class="dw-label">{{ label }}</div>
        <div class="lc-area">
            <div ref="track" class="lc-track">
                <div
                    class="lc-fill"
                    :style="vertical ? { height: `${frac * 100}%`, background: accent } : { width: `${frac * 100}%`, background: accent }"
                />
                <div class="lc-thumb" :style="vertical ? { bottom: `${frac * 100}%` } : { left: `${frac * 100}%` }" />
            </div>
        </div>
        <div v-if="options.showValue || (!ranged && desc)" class="lc-value dw-value">{{ text }}</div>
    </div>
</template>

<style scoped>
.lc {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    touch-action: none;
}
.lc:focus-visible {
    outline: 2px solid var(--d-accent);
    outline-offset: -2px;
    border-radius: 6px;
}
.lc-live {
    cursor: grab;
}
.lc-area {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px 8px;
}
.lc-track {
    position: relative;
    border-radius: 999px;
    background: var(--d-track);
}
.lc-v .lc-track {
    width: clamp(8px, 22cqw, 28px);
    height: 100%;
}
.lc-h .lc-track {
    height: clamp(8px, 22cqh, 28px);
    width: 100%;
}
.lc-fill {
    position: absolute;
    left: 0;
    bottom: 0;
    border-radius: 999px;
}
.lc-v .lc-fill {
    width: 100%;
}
.lc-h .lc-fill {
    height: 100%;
}
.lc-thumb {
    position: absolute;
    background: var(--d-text);
    border-radius: 4px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.lc-v .lc-thumb {
    left: 50%;
    width: 220%;
    height: 10px;
    transform: translate(-50%, 50%);
}
.lc-h .lc-thumb {
    top: 50%;
    height: 220%;
    width: 10px;
    transform: translate(-50%, -50%);
}
.lc-value {
    flex: none;
    text-align: center;
    padding: 0 4px 6px;
    font-size: clamp(11px, 12cqmin, 22px);
}
</style>

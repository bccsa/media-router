<script setup lang="ts">
// The `pidTrim` widget (design §5.5): one signed trim per PID on top of the Ingest Offset O,
// stored as one map (decimal PID → ms) and emitted whole. Rows come from the PIDs the plugin
// publishes (ADR-0007); a trim whose PID left the stream stays in the map, greyed.
import { computed } from 'vue';
import type { FormField } from '@/composables/useModuleSettingsForm';
import { useEntryDrafts } from '@/composables/useEntryDrafts';

const props = defineProps<{
    field: FormField;
    /** The stored map; entries that are not finite numbers are dropped on the next edit. */
    modelValue?: unknown;
    /** Detected PIDs as the plugin publishes them: `{ value: '256', label: '0x0100 H.264 video' }`. */
    options: Array<{ value: string; label: string }>;
    /** Ingest Offset O in ms, for each row's effective shift O + trim. */
    offsetMs?: number;
    /** Why the trims cannot be edited now (Trust, §10.4); shown beside the disabled inputs. */
    disabledReason?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, number>] }>();

interface Row {
    pid: string;
    hex: string;
    type: string;
    trim: number;
    /** False for a stored trim whose PID the stream no longer lists. */
    detected: boolean;
}

const trims = computed<Record<string, number>>(() => {
    const value = props.modelValue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter((e): e is [string, number] => Number.isFinite(e[1])),
    );
});

const pidHex = (pid: string): string =>
    /^\d+$/.test(pid) ? `0x${Number(pid).toString(16).toUpperCase().padStart(4, '0')}` : pid;

// The label leads with the PID in hex, which the row already shows from the value.
const streamType = (label: string): string => label.replace(/^0x[0-9a-f]+\s*/i, '');

const rows = computed<Row[]>(() => {
    const listed = new Set(props.options.map((o) => o.value));
    const detected = props.options.map((o) => ({
        pid: o.value,
        hex: pidHex(o.value),
        type: streamType(o.label),
        trim: trims.value[o.value] ?? 0,
        detected: true,
    }));
    // Integer keys iterate in ascending order, so stale rows come out sorted by PID.
    const stale = Object.keys(trims.value)
        .filter((pid) => !listed.has(pid))
        .map((pid) => ({
            pid,
            hex: pidHex(pid),
            type: 'not in stream',
            trim: trims.value[pid],
            detected: false,
        }));
    return [...detected, ...stale];
});

const unit = computed(() => props.field.unit ?? '');
const step = computed(() => props.field.step ?? 1);
const disabled = computed(() => !!props.disabledReason);
const offset = computed(() =>
    typeof props.offsetMs === 'number' && Number.isFinite(props.offsetMs) ? props.offsetMs : 0,
);
const formatMs = (ms: number): string => String(Math.round(ms * 1000) / 1000);

// Drafts by PID: a new O, another PID's trim or a PMT update can re-render this widget mid-typing.
const drafts = useEntryDrafts();

// On change only (Enter, blur, a spinner step): each live trim edit is a gap or a drop on the
// engine (§5.5), so a half-typed value must never reach it, and one out of bounds is refused.
function commit(row: Row, event: Event): void {
    const { minimum: min, maximum: max } = props.field.additionalProperties ?? {};
    const rule = { type: 'number', min, max, step: step.value, unit: unit.value };
    const next = drafts.commit(row.pid, event, row.trim, rule)?.value as number | undefined;
    if (next === undefined) return;
    const map = { ...trims.value };
    // A zero trim leaves the map, so clearing a stale row removes it.
    if (next === 0) delete map[row.pid];
    else map[row.pid] = next;
    emit('update:modelValue', map);
}

// As in MrInput: a focused number input spins on wheel, so scrolling the panel would edit it.
function onWheel(event: WheelEvent): void {
    (event.target as HTMLElement).blur();
}
</script>

<template>
    <div class="rounded-md border border-border-alt bg-surface-alt p-2 space-y-1.5">
        <p v-if="disabledReason" class="text-[10px] text-subtle" data-test="disabled-reason">
            {{ disabledReason }}
        </p>
        <p v-if="options.length === 0" class="py-2 text-center text-[10px] text-muted">
            Waiting for the stream's PMT
        </p>
        <template v-if="rows.length">
            <div class="flex items-center gap-2 text-[10px] text-muted">
                <span class="flex-1">PID</span>
                <span class="w-20">Trim{{ unit && ` (${unit})` }}</span>
                <span class="w-14 text-right">Shift{{ unit && ` (${unit})` }}</span>
            </div>
            <template v-for="row in rows" :key="row.pid">
                <div
                    :data-pid="row.pid"
                    class="flex items-center gap-2"
                    :class="{ 'opacity-50': disabled || !row.detected }"
                >
                    <div class="flex-1 min-w-0">
                        <div class="font-mono text-xs text-foreground">{{ row.hex }}</div>
                        <div
                            class="truncate text-[10px] text-muted"
                            :title="row.type"
                            data-test="type"
                        >
                            {{ row.type }}
                        </div>
                    </div>
                    <input
                        type="number"
                        :value="drafts.shown(row.pid, row.trim)"
                        :min="field.additionalProperties?.minimum"
                        :max="field.additionalProperties?.maximum"
                        :step="step"
                        :disabled="disabled"
                        :title="disabledReason"
                        :aria-label="`Trim for PID ${row.hex}`"
                        class="w-20 px-2 py-1 text-sm rounded-md outline-none transition-colors bg-input border text-foreground tabular-nums"
                        :class="[
                            { 'cursor-not-allowed': disabled },
                            drafts.reason(row.pid, row.trim) ? 'border-error' : 'border-border',
                        ]"
                        @input="drafts.onInput(row.pid, $event)"
                        @change="commit(row, $event)"
                        @blur="drafts.onBlur(row.pid, $event)"
                        @wheel="onWheel"
                    />
                    <span
                        class="w-14 text-right text-xs tabular-nums text-subtle"
                        data-test="shift"
                    >
                        {{ formatMs(offset + row.trim) }}
                    </span>
                </div>
                <p
                    v-if="drafts.reason(row.pid, row.trim)"
                    class="text-right text-[10px] text-error"
                    :data-reason-pid="row.pid"
                >
                    {{ drafts.reason(row.pid, row.trim) }}
                </p>
            </template>
            <p class="text-[9px] text-muted">
                Shift = Ingest Offset ({{ formatMs(offset) }}{{ unit && ` ${unit}` }}) + trim
            </p>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useEntryDrafts } from '@/composables/useEntryDrafts';

const props = defineProps<{
    modelValue: number;
    min?: number;
    max?: number;
    step?: number;
    showValue?: boolean;
    editable?: boolean;
    unit?: string;
    precision?: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();

const effectivePrecision = computed(() => {
    if (props.precision != null) return props.precision;
    const s = props.step ?? 1;
    if (s >= 1) return 0;
    return Math.max(0, Math.ceil(-Math.log10(s)));
});

function formatted(v: number) {
    return v.toFixed(effectivePrecision.value);
}

// The typed box commits at Enter or on leaving it (B-104): a value out of range is refused with the
// reason, never clamped to the nearest bound. The slider itself writes as it is dragged.
const BOX = 'box';
const drafts = useEntryDrafts();
const reason = computed(() => drafts.reason(BOX, props.modelValue));

function onBoxCommit(e: Event) {
    const rule = { type: 'number', min: props.min ?? 0, max: props.max ?? 100, unit: props.unit };
    const entry = drafts.commit(BOX, e, props.modelValue, rule);
    if (entry) emit('update:modelValue', entry.value as number);
}

// Browsers only change a range/number input on wheel while it is focused, so
// dropping focus stops the value changing while leaving the page scroll untouched.
function onWheel(e: WheelEvent) {
    (e.target as HTMLElement).blur();
}
</script>

<template>
    <div>
        <div class="flex items-center gap-2">
            <input
                type="range"
                :min="min ?? 0"
                :max="max ?? 100"
                :step="step ?? 1"
                :value="modelValue"
                @input="
                    emit('update:modelValue', Number(($event.target as HTMLInputElement).value))
                "
                @wheel="onWheel"
                class="flex-1 h-1 accent-emerald-500 cursor-pointer"
            />
            <div v-if="editable" class="flex items-center gap-0.5 text-xs">
                <input
                    type="number"
                    :min="min ?? 0"
                    :max="max ?? 100"
                    :step="step ?? 1"
                    :value="drafts.shown(BOX, modelValue, formatted(modelValue))"
                    @input="drafts.onInput(BOX, $event)"
                    @change="onBoxCommit"
                    @blur="drafts.onBlur(BOX, $event)"
                    @wheel="onWheel"
                    class="w-12 px-1 py-0.5 text-right tabular-nums rounded bg-input border text-foreground outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    :class="reason ? 'border-error' : 'border-border focus:border-emerald-500'"
                />
                <span v-if="unit" class="text-subtle">{{ unit }}</span>
            </div>
            <span v-else-if="showValue" class="text-xs w-10 text-right tabular-nums text-subtle">
                {{ formatted(modelValue) }}{{ unit ?? '' }}
            </span>
        </div>
        <p v-if="reason" class="mt-1 text-[11px] text-error" data-test="reason">{{ reason }}</p>
    </div>
</template>

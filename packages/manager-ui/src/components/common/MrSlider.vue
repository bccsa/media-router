<script setup lang="ts">
import { computed, ref } from 'vue';

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

const wasClamped = ref(false);
let clampTimer: ReturnType<typeof setTimeout> | null = null;

function clamp(v: number): { value: number; clamped: boolean } {
    const min = props.min ?? 0;
    const max = props.max ?? 100;
    if (v > max) return { value: max, clamped: true };
    if (v < min) return { value: min, clamped: true };
    return { value: v, clamped: false };
}

function formatted(v: number) {
    return v.toFixed(effectivePrecision.value);
}

function flagClamped() {
    wasClamped.value = true;
    if (clampTimer) clearTimeout(clampTimer);
    clampTimer = setTimeout(() => {
        wasClamped.value = false;
    }, 600);
}

function onTextInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    if (raw === '') return;
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    const { value, clamped } = clamp(n);
    if (clamped) flagClamped();
    emit('update:modelValue', value);
}
</script>

<template>
    <div class="flex items-center gap-2">
        <input
            type="range"
            :min="min ?? 0"
            :max="max ?? 100"
            :step="step ?? 1"
            :value="modelValue"
            @input="emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
            class="flex-1 h-1 accent-emerald-500 cursor-pointer"
        />
        <div v-if="editable" class="flex items-center gap-0.5 text-xs">
            <input
                type="number"
                :min="min ?? 0"
                :max="max ?? 100"
                :step="step ?? 1"
                :value="formatted(modelValue)"
                @input="onTextInput"
                class="w-12 px-1 py-0.5 text-right tabular-nums rounded bg-input border text-foreground outline-none transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                :class="
                    wasClamped
                        ? 'border-amber-500 ring-1 ring-amber-500/40'
                        : 'border-border focus:border-emerald-500'
                "
            />
            <span v-if="unit" class="text-subtle">{{ unit }}</span>
        </div>
        <span v-else-if="showValue" class="text-xs w-10 text-right tabular-nums text-subtle">
            {{ formatted(modelValue) }}{{ unit ?? '' }}
        </span>
    </div>
</template>

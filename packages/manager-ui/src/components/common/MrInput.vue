<script setup lang="ts">
const props = defineProps<{
    modelValue?: string | number;
    label?: string;
    description?: string;
    type?: 'text' | 'number' | 'password' | 'email';
    placeholder?: string;
    error?: string;
    disabled?: boolean;
    min?: number;
    max?: number;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
}>();

function clamp(n: number): number {
    return Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n));
}

// Keystrokes only emit values already inside [min, max]; an out-of-range
// partial entry ("4" on the way to "48" with min 6) stays in the box and is
// clamped when the edit commits (change = Enter/blur). Clamping per keystroke
// rebinds the box to the bound and makes every value below it untypeable.
function onInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    if (props.type !== 'number') {
        emit('update:modelValue', raw);
        return;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && clamp(n) === n) emit('update:modelValue', n);
}

function onChange(e: Event) {
    if (props.type !== 'number') return;
    const el = e.target as HTMLInputElement;
    const n = Number(el.value);
    const committed = clamp(Number.isFinite(n) ? n : Number(props.modelValue ?? props.min ?? 0));
    el.value = String(committed);
    if (committed !== props.modelValue) emit('update:modelValue', committed);
}

// Browsers only spin a number input on wheel while it is focused, so dropping
// focus stops the value changing while leaving the page scroll untouched.
function onWheel(e: WheelEvent) {
    if (props.type === 'number') (e.target as HTMLElement).blur();
}
</script>

<template>
    <div class="space-y-1">
        <label v-if="label" class="block text-xs font-medium text-foreground">
            {{ label }}
        </label>
        <p v-if="description" class="text-[11px] text-muted">{{ description }}</p>
        <input
            :type="type ?? 'text'"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            :min="min"
            :max="max"
            @input="onInput"
            @change="onChange"
            @wheel="onWheel"
            class="w-full px-2.5 py-1.5 text-sm rounded-md outline-none transition-colors bg-input border text-foreground"
            :class="[
                disabled ? 'opacity-50 cursor-not-allowed' : '',
                error ? 'border-error' : 'border-border',
            ]"
        />
        <p v-if="error" class="text-[11px] text-error">{{ error }}</p>
    </div>
</template>

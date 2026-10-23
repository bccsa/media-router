<script setup lang="ts">
import { computed } from 'vue';
import { useEntryDrafts } from '@/composables/useEntryDrafts';
import type { EntryRule } from '@/utils/entryRules';

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
    /** A box that writes a setting: its rules (a text box given one commits as a number box does). */
    rule?: EntryRule;
    /** Shown beside the box. */
    unit?: string;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
}>();

// B-104: a number box, and a text box given a rule, keep what is typed and read it at Enter, on
// leaving the box or at a spinner step: a valid change emits once, a refused one says why. A text
// box without a rule (a dialog's field, read by its button) emits every keystroke.
const commitRule = computed<EntryRule | undefined>(() =>
    props.type === 'number'
        ? { type: 'number', min: props.min, max: props.max, ...props.rule }
        : props.rule,
);

const BOX = 'box';
const drafts = useEntryDrafts();

const shown = computed(() =>
    commitRule.value ? drafts.shown(BOX, props.modelValue) : props.modelValue,
);
// A parent's error (a duplicate value) gives way while a new entry is typed.
const shownError = computed(() => {
    if (!commitRule.value) return props.error;
    const reason = drafts.reason(BOX, props.modelValue);
    return reason ?? (drafts.typing(BOX, props.modelValue) ? undefined : props.error);
});

function onInput(e: Event) {
    if (commitRule.value) drafts.onInput(BOX, e);
    else emit('update:modelValue', (e.target as HTMLInputElement).value);
}

function onChange(e: Event) {
    if (!commitRule.value) return;
    const entry = drafts.commit(BOX, e, props.modelValue, commitRule.value);
    if (entry) emit('update:modelValue', entry.value);
}

function onBlur(e: FocusEvent) {
    if (commitRule.value) drafts.onBlur(BOX, e);
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
        <div class="flex items-center gap-1.5">
            <input
                :type="type ?? 'text'"
                :value="shown"
                :placeholder="placeholder"
                :disabled="disabled"
                :min="commitRule?.min"
                :max="commitRule?.max"
                @input="onInput"
                @change="onChange"
                @blur="onBlur"
                @wheel="onWheel"
                class="flex-1 min-w-0 px-2.5 py-1.5 text-sm rounded-md outline-none transition-colors bg-input border text-foreground"
                :class="[
                    disabled ? 'opacity-50 cursor-not-allowed' : '',
                    shownError ? 'border-error' : 'border-border',
                ]"
            />
            <span v-if="unit" class="text-xs text-muted" data-test="unit">{{ unit }}</span>
        </div>
        <p v-if="shownError" class="text-[11px] text-error" data-test="reason">{{ shownError }}</p>
    </div>
</template>

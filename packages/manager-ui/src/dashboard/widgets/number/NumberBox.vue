<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { WidgetProps } from '../../registry';
import { asNumber, clampNumber, formatValue, numberOption, stepDecimals } from '../../valueTypes';

const props = defineProps<WidgetProps>();
const emit = defineEmits<{ write: [value: number] }>();

const editing = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

const step = computed(() => Number(props.options.step) || props.desc?.step || 1);
const decimals = computed(() => numberOption(props.options.decimals) ?? stepDecimals(step.value));
const num = computed(() => asNumber(props.value));
const text = computed(() => formatValue(num.value, decimals.value, props.options.showUnit ? props.desc?.unit : undefined));

function clamp(v: number): number {
    const out = clampNumber(v, props.desc?.min, props.desc?.max);
    return props.desc?.type === 'integer' ? Math.round(out) : out;
}

function bump(dir: 1 | -1) {
    if (!props.interactive) return;
    emit('write', clamp((num.value ?? 0) + dir * step.value));
}

async function edit() {
    if (!props.interactive) return;
    draft.value = num.value === undefined ? '' : String(num.value);
    editing.value = true;
    await nextTick();
    input.value?.select();
}

function commit() {
    if (!editing.value) return;
    editing.value = false;
    const v = Number(draft.value);
    if (draft.value.trim() !== '' && Number.isFinite(v)) emit('write', clamp(v));
}
</script>

<template>
    <div class="nb">
        <div class="dw-label">{{ label }}</div>
        <div class="nb-row">
            <button type="button" class="nb-step" :disabled="!interactive" :aria-label="`${label}: down`" @click="bump(-1)">−</button>
            <input
                v-if="editing"
                ref="input"
                v-model="draft"
                class="nb-input"
                inputmode="decimal"
                @keydown.enter="commit"
                @keydown.esc="editing = false"
                @blur="commit"
            />
            <button v-else type="button" class="nb-value dw-value" :class="{ 'nb-live': interactive }" :disabled="!interactive" :aria-label="`${label}: ${text}, edit`" @click="edit">
                {{ text }}
            </button>
            <button type="button" class="nb-step" :disabled="!interactive" :aria-label="`${label}: up`" @click="bump(1)">+</button>
        </div>
    </div>
</template>

<style scoped>
.nb {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.nb-row {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px 6px;
}
.nb-value,
.nb-input {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-size: clamp(12px, 30cqh, 34px);
}
.nb-value {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font-family: inherit;
    font-weight: inherit;
}
.nb-live {
    cursor: text;
}
.nb-input {
    background: var(--d-bg);
    color: var(--d-text);
    border: 1px solid var(--d-accent);
    border-radius: 6px;
    padding: 2px 4px;
    user-select: text;
}
.nb-step {
    flex: none;
    width: clamp(28px, 22cqw, 48px);
    height: 70%;
    border-radius: 6px;
    border: 1px solid var(--d-border);
    background: var(--d-track);
    color: var(--d-text);
    font-size: clamp(14px, 24cqh, 26px);
    cursor: pointer;
}
.nb-step:disabled {
    opacity: 0.4;
    cursor: default;
}
</style>

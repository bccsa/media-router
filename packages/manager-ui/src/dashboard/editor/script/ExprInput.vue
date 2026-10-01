<script setup lang="ts">
import { computed, ref } from 'vue';
import * as shared from '@media-router/shared-types';
import type { ScriptExpr, ScriptOp } from '@media-router/shared-types';
import MrSelect from '@/components/common/MrSelect.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrButton from '@/components/common/MrButton.vue';
import ValuePicker from '../ValuePicker.vue';
import type { ValueEntry } from '../../entries';
import type { DashboardSource } from '../../source';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { SCRIPT_OPS } = shared;

/** One value in a script (ADR-0027): a literal, a value read at run time, or a combination. */
const props = defineProps<{ modelValue: ScriptExpr; source: DashboardSource; pickRouter?: boolean; depth?: number }>();
const emit = defineEmits<{ 'update:modelValue': [e: ScriptExpr] }>();

type Mode = 'number' | 'text' | 'bool' | 'read' | 'op' | 'not';
const MODES = [
    { value: 'number', label: 'Number' },
    { value: 'text', label: 'Text' },
    { value: 'bool', label: 'On / off' },
    { value: 'read', label: 'A value' },
    { value: 'op', label: 'Calculate / compare' },
    { value: 'not', label: 'Not …' },
];
const OP_LABELS: Record<ScriptOp, string> = {
    '+': '+', '-': '−', '*': '×', '/': '÷', '=': '=', '!=': '≠', '<': '<', '>': '>', '<=': '≤', '>=': '≥', and: 'and', or: 'or',
};
const ops = SCRIPT_OPS.map((o) => ({ value: o, label: OP_LABELS[o] }));

const e = computed(() => props.modelValue);
const mode = computed<Mode>(() => {
    const v = e.value;
    if ('read' in v) return 'read';
    if ('op' in v) return 'op';
    if ('not' in v) return 'not';
    return typeof v.lit === 'number' ? 'number' : typeof v.lit === 'boolean' ? 'bool' : 'text';
});
const depth = computed(() => props.depth ?? 0);
const picking = ref(false);

function setMode(m: string) {
    const blank: Record<Mode, ScriptExpr> = {
        number: { lit: 0 },
        text: { lit: '' },
        bool: { lit: true },
        read: { read: '' },
        op: { op: '=', a: { read: '' }, b: { lit: 0 } },
        not: { not: { read: '' } },
    };
    emit('update:modelValue', blank[m as Mode]);
}
const accept = (x: ValueEntry) => x.desc.type !== 'object';
function pick(x: ValueEntry) {
    picking.value = false;
    emit('update:modelValue', { read: x.path });
}
const lit = (v: unknown) => emit('update:modelValue', { lit: v as number | string | boolean });
const litValue = computed(() => ('lit' in e.value ? e.value.lit : undefined));
const readPath = computed(() => ('read' in e.value ? e.value.read : ''));
const opExpr = computed(() => ('op' in e.value ? e.value : undefined));
const notExpr = computed(() => ('not' in e.value ? e.value.not : undefined));
const setPart = (key: 'a' | 'b' | 'op', v: unknown) => opExpr.value && emit('update:modelValue', { ...opExpr.value, [key]: v } as ScriptExpr);
</script>

<template>
    <div class="space-y-1" :class="depth > 0 ? 'pl-2 border-l border-border' : ''">
        <MrSelect :model-value="mode" :options="MODES" @update:model-value="setMode(String($event))" />
        <MrInput v-if="mode === 'number'" type="number" :model-value="Number(litValue)" @update:model-value="lit(Number($event))" />
        <MrInput v-else-if="mode === 'text'" :model-value="String(litValue ?? '')" @update:model-value="lit(String($event))" />
        <MrToggle v-else-if="mode === 'bool'" :model-value="litValue === true" label="On" @update:model-value="lit($event)" />
        <div v-else-if="mode === 'read'" class="flex items-center gap-2">
            <span class="flex-1 text-xs text-subtle break-all">{{ readPath || 'No value chosen' }}</span>
            <MrButton size="sm" variant="secondary" @click="picking = true">Choose…</MrButton>
        </div>
        <template v-else-if="opExpr">
            <ExprInput :model-value="opExpr.a" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update:model-value="setPart('a', $event)" />
            <MrSelect :model-value="opExpr.op" :options="ops" @update:model-value="setPart('op', $event)" />
            <ExprInput :model-value="opExpr.b" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update:model-value="setPart('b', $event)" />
        </template>
        <ExprInput v-else-if="notExpr" :model-value="notExpr" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update:model-value="emit('update:modelValue', { not: $event })" />
        <ValuePicker v-if="picking" :source="source" :accept="accept" :pick-router="pickRouter" title="Value to read" @pick="pick" @close="picking = false" />
    </div>
</template>

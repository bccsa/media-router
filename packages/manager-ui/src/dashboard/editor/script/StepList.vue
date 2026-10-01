<script setup lang="ts">
import { computed } from 'vue';
import * as shared from '@media-router/shared-types';
import type { ScriptStep } from '@media-router/shared-types';
import { ArrowDown, ArrowUp, X } from 'lucide-vue-next';
import MrSelect from '@/components/common/MrSelect.vue';
import StepEditor from './StepEditor.vue';
import { stepText } from '../../scriptText';
import type { DashboardSource } from '../../source';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { SCRIPT_MAX_DEPTH } = shared;

/** Steps in order: actions and waits, and the logic blocks. */
const props = defineProps<{ steps: ScriptStep[]; source: DashboardSource; pickRouter?: boolean; depth?: number }>();
const emit = defineEmits<{ update: [steps: ScriptStep[]]; confirm: [] }>();

const depth = computed(() => props.depth ?? 0);
const ADD: Array<{ value: string; label: string; step: ScriptStep; nests?: boolean }> = [
    { value: 'action', label: 'Action', step: { do: 'call', path: '', method: 'restart' } },
    { value: 'wait', label: 'Wait', step: { do: 'wait', seconds: { lit: 1 } } },
    { value: 'set', label: 'Set a value to a calculation', step: { do: 'write', path: '', value: { op: '+', a: { read: '' }, b: { lit: 1 } } } },
    { value: 'if', label: 'If … then … otherwise', step: { do: 'if', cond: { op: '=', a: { read: '' }, b: { lit: 0 } }, then: [] }, nests: true },
    { value: 'repeat', label: 'Repeat N times', step: { do: 'repeat', times: { lit: 3 }, body: [] }, nests: true },
    { value: 'until', label: 'Repeat until …', step: { do: 'until', cond: { op: '=', a: { read: '' }, b: { lit: 0 } }, body: [] }, nests: true },
    { value: 'waitUntil', label: 'Wait until …', step: { do: 'waitUntil', cond: { op: '=', a: { read: '' }, b: { lit: 0 } }, timeoutS: 10 } },
    { value: 'stop', label: 'Stop', step: { do: 'stop' } },
];
const addOptions = computed(() =>
    ADD.filter((a) => !a.nests || depth.value + 1 < SCRIPT_MAX_DEPTH).map(({ value, label }) => ({ value, label })),
);

function add(kind: string) {
    const a = ADD.find((x) => x.value === kind);
    if (a) emit('update', [...props.steps, structuredClone(a.step)]);
}
const replace = (i: number, s: ScriptStep) => emit('update', props.steps.map((x, j) => (j === i ? s : x)));
const remove = (i: number) => emit('update', props.steps.filter((_, j) => j !== i));
function move(i: number, by: number) {
    const next = [...props.steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    emit('update', next);
}
</script>

<template>
    <div class="space-y-2">
        <div v-for="(s, i) in steps" :key="i" class="flex gap-1">
            <div class="flex-1 min-w-0">
                <StepEditor :step="s" :source="source" :pick-router="pickRouter" :depth="depth" @update="replace(i, $event)" @confirm="emit('confirm')" />
            </div>
            <div class="flex flex-col gap-1 pt-1">
                <button class="text-muted hover:text-foreground disabled:opacity-30" :disabled="i === 0" :aria-label="`Move ${stepText(s)} up`" @click="move(i, -1)"><ArrowUp :size="14" /></button>
                <button class="text-muted hover:text-foreground disabled:opacity-30" :disabled="i === steps.length - 1" :aria-label="`Move ${stepText(s)} down`" @click="move(i, 1)"><ArrowDown :size="14" /></button>
                <button class="text-muted hover:text-foreground" :aria-label="`Remove ${stepText(s)}`" @click="remove(i)"><X :size="14" /></button>
            </div>
        </div>
        <div v-if="steps.length === 0" class="text-xs text-subtle">Nothing here yet</div>
        <MrSelect :model-value="undefined" placeholder="+ Add…" :options="addOptions" @update:model-value="add(String($event))" />
    </div>
</template>

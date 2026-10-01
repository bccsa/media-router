<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DashboardAction, ScriptExpr, ScriptStep } from '@media-router/shared-types';
import MrInput from '@/components/common/MrInput.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrButton from '@/components/common/MrButton.vue';
import ActionPicker from '../ActionPicker.vue';
import ValuePicker from '../ValuePicker.vue';
import ExprInput from './ExprInput.vue';
import StepList from './StepList.vue';
import { actionFromStep, stepFromAction } from '../../scriptText';
import type { ValueEntry } from '../../entries';
import type { DashboardSource } from '../../source';

/** One step of a button's script (ADR-0027); control blocks hold step lists. */
const props = defineProps<{ step: ScriptStep; source: DashboardSource; pickRouter?: boolean; depth: number }>();
const emit = defineEmits<{ update: [s: ScriptStep]; confirm: [] }>();

const TITLES: Record<ScriptStep['do'], string> = {
    call: 'Action', write: 'Action', wait: 'Wait', if: 'If', repeat: 'Repeat', until: 'Repeat until', waitUntil: 'Wait until', stop: 'Stop',
};
const s = computed(() => props.step);
/** A write whose value is computed, not a fixed value: its own editor. */
const computedWrite = computed(() => s.value.do === 'write' && !('lit' in s.value.value));
const title = computed(() => (computedWrite.value ? 'Set a value' : TITLES[s.value.do]));

function fromAction(a: DashboardAction | undefined, confirm: boolean) {
    if (confirm) emit('confirm');
    // Until the action is complete the step keeps its place, unset.
    emit('update', a ? stepFromAction(a) : { do: 'call', path: '', method: 'restart' });
}
const set = (patch: Partial<ScriptStep>) => emit('update', { ...s.value, ...patch } as ScriptStep);
const expr = (key: string, v: ScriptExpr) => set({ [key]: v } as Partial<ScriptStep>);

const picking = ref(false);
const accept = (e: ValueEntry) => e.desc.access === 'write' && e.desc.type !== 'object';
function pickTarget(e: ValueEntry) {
    picking.value = false;
    set({ path: e.path } as Partial<ScriptStep>);
}
const accent = computed(() => (['if', 'repeat', 'until', 'waitUntil'].includes(s.value.do) ? 'border-l-amber-500' : s.value.do === 'stop' ? 'border-l-red-500' : 'border-l-emerald-500'));
</script>

<template>
    <div class="rounded-md border border-border border-l-4 bg-surface-alt/30 p-2 space-y-2" :class="accent">
        <!-- The action picker labels itself. -->
        <div v-if="(s.do !== 'call' && s.do !== 'write') || computedWrite" class="text-xs font-semibold text-foreground">{{ title }}</div>

        <ActionPicker
            v-if="(s.do === 'call' || s.do === 'write') && !computedWrite"
            :source="source"
            :action="actionFromStep(s)?.path ? actionFromStep(s) : undefined"
            :pick-router="pickRouter"
            @update="fromAction"
        />
        <template v-else-if="s.do === 'write'">
            <div class="flex items-center gap-2">
                <span class="flex-1 text-xs text-subtle break-all">{{ s.path || 'No value chosen' }}</span>
                <MrButton size="sm" variant="secondary" @click="picking = true">Choose value…</MrButton>
            </div>
            <div class="text-[11px] text-muted">Set to</div>
            <ExprInput :model-value="s.value" :source="source" :pick-router="pickRouter" @update:model-value="expr('value', $event)" />
        </template>
        <template v-else-if="s.do === 'wait'">
            <ExprInput :model-value="s.seconds" :source="source" :pick-router="pickRouter" @update:model-value="expr('seconds', $event)" />
        </template>
        <template v-else-if="s.do === 'if'">
            <ExprInput :model-value="s.cond" :source="source" :pick-router="pickRouter" @update:model-value="expr('cond', $event)" />
            <div class="text-[11px] text-muted">Then</div>
            <StepList :steps="s.then" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update="set({ then: $event })" @confirm="emit('confirm')" />
            <MrToggle :model-value="!!s.else" label="Otherwise…" @update:model-value="set({ else: $event ? [] : undefined })" />
            <StepList v-if="s.else" :steps="s.else" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update="set({ else: $event })" @confirm="emit('confirm')" />
        </template>
        <template v-else-if="s.do === 'repeat'">
            <div class="text-[11px] text-muted">Times</div>
            <ExprInput :model-value="s.times" :source="source" :pick-router="pickRouter" @update:model-value="expr('times', $event)" />
            <StepList :steps="s.body" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update="set({ body: $event })" @confirm="emit('confirm')" />
        </template>
        <template v-else-if="s.do === 'until'">
            <ExprInput :model-value="s.cond" :source="source" :pick-router="pickRouter" @update:model-value="expr('cond', $event)" />
            <StepList :steps="s.body" :source="source" :pick-router="pickRouter" :depth="depth + 1" @update="set({ body: $event })" @confirm="emit('confirm')" />
        </template>
        <template v-else-if="s.do === 'waitUntil'">
            <ExprInput :model-value="s.cond" :source="source" :pick-router="pickRouter" @update:model-value="expr('cond', $event)" />
            <MrInput type="number" label="Give up after (s)" :model-value="s.timeoutS" @update:model-value="set({ timeoutS: Math.max(1, Number($event) || 1) })" />
        </template>
        <div v-else-if="s.do === 'stop'" class="text-xs text-subtle">Ends the run here.</div>

        <ValuePicker v-if="picking" :source="source" :accept="accept" :pick-router="pickRouter" title="Value to set" @pick="pickTarget" @close="picking = false" />
    </div>
</template>

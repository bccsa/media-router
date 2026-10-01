<script setup lang="ts">
import { computed, ref } from 'vue';
import * as shared from '@media-router/shared-types';
import type { DashboardScript, DashboardWidget, ScriptStep } from '@media-router/shared-types';
import MrInput from '@/components/common/MrInput.vue';
import MrButton from '@/components/common/MrButton.vue';
import MrModal from '@/components/common/MrModal.vue';
import StepList from './StepList.vue';
import { stepFromAction } from '../../scriptText';
import type { DashboardSource } from '../../source';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { SCRIPT_DEFAULT_TIMEOUT_S, SCRIPT_MAX_TIMEOUT_S, scriptPaths } = shared;

/**
 * A button's actions (ADR-0027): actions and waits, with logic blocks where
 * wanted. Runs on the server the dashboard is opened from.
 */
const props = defineProps<{ widget: DashboardWidget; source: DashboardSource; pickRouter?: boolean }>();
const emit = defineEmits<{ update: [script: DashboardScript | undefined]; confirm: [] }>();

/** A long script is easier to set up in a wide modal than in the side panel. */
const expanded = ref(false);
/** The button's older single action, shown as a one-step list until edited. */
const script = computed<DashboardScript>(
    () => props.widget.script ?? { steps: props.widget.action ? [stepFromAction(props.widget.action)] : [] },
);

/** Steps not set up yet: a save would refuse them. */
const unset = computed(() => {
    const blank = (s: ScriptStep): boolean =>
        ((s.do === 'call' || s.do === 'write') && !s.path) ||
        scriptPaths([s]).some((p) => p === '') ||
        ('then' in s && s.then.some(blank)) ||
        ('else' in s && (s.else ?? []).some(blank)) ||
        ('body' in s && s.body.some(blank));
    return script.value.steps.filter(blank).length;
});

function update(patch: Partial<DashboardScript>) {
    const next = { ...script.value, ...patch };
    emit('update', next.steps.length > 0 ? next : undefined);
}
</script>

<template>
    <div class="space-y-2">
        <div class="text-xs font-medium text-foreground">Actions</div>
        <MrButton size="sm" variant="secondary" @click="expanded = true">Open editor…</MrButton>
        <StepList
            :steps="script.steps"
            :source="source"
            :pick-router="pickRouter"
            @update="update({ steps: $event })"
            @confirm="emit('confirm')"
        />
        <div v-if="unset > 0" class="text-[11px] text-amber-400">{{ unset }} step{{ unset === 1 ? ' is' : 's are' }} not set up yet</div>
        <MrModal v-if="expanded" title="Button actions" width="max-w-3xl" @close="expanded = false">
            <div class="max-h-[70vh] overflow-auto space-y-2 pr-1">
                <StepList
                    :steps="script.steps"
                    :source="source"
                    :pick-router="pickRouter"
                    @update="update({ steps: $event })"
                    @confirm="emit('confirm')"
                />
                <div v-if="unset > 0" class="text-[11px] text-amber-400">{{ unset }} step{{ unset === 1 ? ' is' : 's are' }} not set up yet</div>
            </div>
            <template #footer>
                <MrButton size="sm" @click="expanded = false">Done</MrButton>
            </template>
        </MrModal>
        <MrInput
            type="number"
            label="Max run time (s)"
            :description="`A run stops after this long (default ${SCRIPT_DEFAULT_TIMEOUT_S} s, up to ${SCRIPT_MAX_TIMEOUT_S} s).`"
            :model-value="script.timeoutS ?? SCRIPT_DEFAULT_TIMEOUT_S"
            @update:model-value="update({ timeoutS: Math.min(SCRIPT_MAX_TIMEOUT_S, Math.max(1, Math.round(Number($event) || SCRIPT_DEFAULT_TIMEOUT_S))) })"
        />
    </div>
</template>

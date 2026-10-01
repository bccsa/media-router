<script setup lang="ts">
import { computed, ref } from 'vue';
import * as shared from '@media-router/shared-types';
import type { DashboardScript } from '@media-router/shared-types';
import { X } from 'lucide-vue-next';
import MrButton from '@/components/common/MrButton.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import OptionField from './OptionField.vue';
import ButtonScript from './script/ButtonScript.vue';
import ValuePicker from './ValuePicker.vue';
import { WIDGETS, canBind, commonOptions, optionsOf, takesInput as takesInputDef } from '../registry';
import type { ValueEntry } from '../entries';
import type { DashboardSource } from '../source';
import type { Draft } from './useDraft';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { DASHBOARD_MAX_BINDS } = shared;

const props = defineProps<{ draft: Draft; source: DashboardSource; pickRouter?: boolean }>();
const emit = defineEmits<{ duplicateFor: [] }>();

const widget = computed(() => (props.draft.selection.value.length === 1 ? props.draft.selection.value[0] : undefined));
const def = computed(() => (widget.value ? WIDGETS[widget.value.type] : undefined));
const options = computed(() => (widget.value ? optionsOf(def.value, widget.value) : {}));
const picking = ref(false);

const commonFields = computed(() => (def.value ? commonOptions(def.value) : []));
const takesInput = computed(() => !!def.value && takesInputDef(def.value));

const accept = (e: ValueEntry) => !!def.value && canBind(def.value, e, !!widget.value?.inputDisabled);

function pick(e: ValueEntry) {
    picking.value = false;
    const w = widget.value;
    if (!w) return;
    if (def.value?.binds !== 'values') props.draft.update(w.id, { bind: e.path });
    else if (!(w.binds ?? []).includes(e.path)) props.draft.update(w.id, { binds: [...(w.binds ?? []), e.path] });
}

function removeValue(path: string) {
    const w = widget.value;
    if (!w) return;
    const rest = (w.binds ?? []).filter((p) => p !== path);
    props.draft.update(w.id, { binds: rest.length > 0 ? rest : undefined });
}

/** The button's actions replace its older single action (ADR-0027). */
function setScript(script: DashboardScript | undefined) {
    if (!widget.value) return;
    props.draft.update(widget.value.id, { script, action: undefined });
}

/** A step that stops, restarts, resets or reboots asks to confirm, unless the author said no. */
function wantConfirm() {
    const w = widget.value;
    if (w && w.options?.confirm === undefined) props.draft.setOption(w.id, 'confirm', true);
}

/** A widget name mid-sentence: "Fader" → "fader", but "VU meter" keeps its acronym. */
const inSentence = (name: string) => (/^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);
</script>

<template>
    <div class="space-y-4 text-sm">
        <template v-if="widget && def">
            <div class="font-semibold text-foreground">{{ def.label }}</div>

            <div v-if="def.binds === 'value'" class="space-y-1">
                <div class="text-xs font-medium text-foreground">Value</div>
                <div class="text-xs text-subtle break-all">{{ widget.bind ?? 'Not tied to a value yet' }}</div>
                <div class="flex gap-2">
                    <MrButton size="sm" variant="secondary" @click="picking = true">Choose value…</MrButton>
                    <MrButton v-if="widget.bind" size="sm" variant="secondary" @click="draft.update(widget.id, { bind: undefined })">Clear</MrButton>
                </div>
            </div>
            <div v-else-if="def.binds === 'values'" class="space-y-1">
                <div class="text-xs font-medium text-foreground">Values ({{ widget.binds?.length ?? 0 }} of {{ DASHBOARD_MAX_BINDS }})</div>
                <div v-for="p in widget.binds ?? []" :key="p" class="flex items-start gap-2">
                    <span class="flex-1 text-xs text-subtle break-all">{{ p }}</span>
                    <button class="text-muted hover:text-foreground" aria-label="Remove this value" @click="removeValue(p)"><X :size="14" /></button>
                </div>
                <div v-if="!widget.binds?.length" class="text-xs text-subtle">No values yet</div>
                <MrButton size="sm" variant="secondary" :disabled="(widget.binds?.length ?? 0) >= DASHBOARD_MAX_BINDS" @click="picking = true">Add value…</MrButton>
            </div>
            <ButtonScript
                v-else-if="def.binds === 'action'"
                :key="widget.id"
                :widget="widget"
                :source="source"
                :pick-router="pickRouter"
                @update="setScript"
                @confirm="wantConfirm"
            />

            <MrToggle
                v-if="takesInput"
                :model-value="!!widget.inputDisabled"
                label="Input disabled"
                description="Display only: nobody can change it from the dashboard"
                @update:model-value="(v) => draft.update(widget!.id, { inputDisabled: v })"
            />
            <OptionField
                v-for="o in [...commonFields, ...def.options]"
                :key="o.key"
                :def="o"
                :value="options[o.key]"
                @change="(v) => draft.setOption(widget!.id, o.key, v)"
            />
        </template>

        <div v-else-if="draft.selection.value.length > 1" class="text-subtle">{{ draft.selection.value.length }} widgets selected</div>
        <div v-else class="text-muted">Select a widget, or add one from the left.</div>

        <div v-if="draft.selection.value.length > 0" class="flex flex-wrap gap-2 pt-2 border-t border-border">
            <MrButton size="sm" variant="secondary" :disabled="!draft.selectionModule.value" @click="emit('duplicateFor')">Duplicate for…</MrButton>
            <MrButton size="sm" variant="secondary" @click="draft.restack(true)">To front</MrButton>
            <MrButton size="sm" variant="secondary" @click="draft.restack(false)">To back</MrButton>
            <MrButton size="sm" variant="danger" @click="draft.remove()">Delete</MrButton>
        </div>

        <ValuePicker
            v-if="picking && def"
            :source="source"
            :accept="accept"
            :pick-router="pickRouter"
            :title="def.binds === 'values' ? `Add a value to this ${inSentence(def.label)}` : `Value for this ${inSentence(def.label)}`"
            @pick="pick"
            @close="picking = false"
        />
    </div>
</template>

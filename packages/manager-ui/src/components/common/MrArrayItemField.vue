<script setup lang="ts">
/**
 * One labelled control inside an MrArrayField item. Renders an enum select or a
 * text/number input from a JSON-schema property, and encapsulates the
 * "advanced" inherit semantics: an advanced field with no value is shown as
 * "Inherit (global)" and can be reset to inherit (emits `clear`, so the parent
 * drops the key from the item — an absent key means "inherit the module-global
 * setting").
 */
import { computed } from 'vue';
import MrInput from './MrInput.vue';
import MrSelect from './MrSelect.vue';
import MrToggle from './MrToggle.vue';

export interface ItemField {
    key: string;
    type: string;
    description: string;
    /** Schema default — an unset boolean toggle displays this state. */
    default?: unknown;
    enumValues?: unknown[];
    enumLabels?: Record<string, string>;
    /** Grouped under the collapsed "Advanced" section. */
    advanced: boolean;
    /** Inherit semantics — only when the module has a SAME-NAMED global this
     *  field overrides (video-transcoder per-rendition overrides). Advanced
     *  fields without a global are ordinary fields with their own default
     *  (audio-transcoder opus knobs). */
    inheritable?: boolean;
}

const props = defineProps<{
    field: ItemField;
    value: unknown;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    update: [value: unknown];
    /** Reset to inherit — parent removes the key from the item. */
    clear: [];
}>();

/** Sentinel option value for the "Inherit (global)" choice on advanced enums. */
const INHERIT = '__inherit__';

const isSet = computed(() => props.value !== undefined && props.value !== '');

/** Booleans render as a real toggle. An unset advanced boolean shows the
 *  schema default; interacting writes an explicit value, and the ↺ button
 *  (same affordance as number overrides) clears back to inherit. */
const isBoolean = computed(() => props.field.type === 'boolean');

const toggleValue = computed(() => (isSet.value ? props.value === true : props.field.default === true));

const selectOptions = computed(() => {
    const opts = (props.field.enumValues ?? []).map((v) => ({
        value: (props.field.type === 'number' ? Number(v) : String(v)) as string | number,
        label: props.field.enumLabels?.[String(v)] ?? String(v),
    }));
    // Inheritable overrides can fall back to the module-global value — offer
    // an explicit way back to inherit after a value has been picked.
    if (props.field.inheritable) {
        return [{ value: INHERIT, label: 'Inherit (global)' }, ...opts];
    }
    return opts;
});

const selectValue = computed<string | number | undefined>(() => {
    if (props.field.inheritable && !isSet.value) return INHERIT;
    return props.value as string | number | undefined;
});

function onSelect(value: string | number): void {
    if (props.field.inheritable && value === INHERIT) {
        emit('clear');
        return;
    }
    emit('update', value);
}

function onInput(value: string | number): void {
    // A blank text input on an inheritable field means "inherit" (clear the
    // key). Number inputs can't use this — MrInput coerces '' to 0 (a
    // meaningful value), so numeric overrides reset via the ↺ button instead.
    if (props.field.inheritable && (value === '' || value === undefined)) {
        emit('clear');
        return;
    }
    emit('update', props.field.type === 'number' ? Number(value) : value);
}
</script>

<template>
    <div class="space-y-0.5">
        <label class="text-[10px] text-muted">{{ field.description }}</label>

        <MrSelect
            v-if="field.enumValues"
            :model-value="selectValue"
            :options="selectOptions"
            :placeholder="field.inheritable ? 'Inherit (global)' : undefined"
            :disabled="disabled"
            @update:model-value="onSelect"
        />

        <!-- Boolean toggle (↺ resets an advanced override back to inherit) -->
        <div v-else-if="isBoolean" class="flex items-center gap-1.5">
            <MrToggle
                :model-value="toggleValue"
                :disabled="disabled"
                @update:model-value="emit('update', $event)"
            />
            <span v-if="field.inheritable && !isSet" class="text-[10px] text-muted">inherit</span>
            <button
                v-if="field.inheritable && isSet"
                type="button"
                title="Reset to inherit global"
                class="text-[11px] px-1 rounded text-muted hover:text-foreground transition-colors"
                :disabled="disabled"
                @click="emit('clear')"
            >
                ↺
            </button>
        </div>

        <div v-else class="flex items-center gap-1">
            <div class="flex-1">
                <MrInput
                    :model-value="isSet ? (value as string | number) : ''"
                    :type="field.type === 'number' ? 'number' : 'text'"
                    :placeholder="field.inheritable ? 'Inherit (global)' : undefined"
                    :disabled="disabled"
                    @update:model-value="onInput"
                />
            </div>
            <!-- Explicit reset-to-inherit for advanced number overrides (a blank
                 number input can't express inherit — MrInput coerces it to 0). -->
            <button
                v-if="field.inheritable && isSet"
                type="button"
                title="Reset to inherit global"
                class="text-[11px] px-1 rounded text-muted hover:text-foreground transition-colors"
                :disabled="disabled"
                @click="emit('clear')"
            >
                ↺
            </button>
        </div>
    </div>
</template>

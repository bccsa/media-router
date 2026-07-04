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

export interface ItemField {
    key: string;
    type: string;
    description: string;
    enumValues?: unknown[];
    enumLabels?: Record<string, string>;
    advanced: boolean;
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

const selectOptions = computed(() => {
    const opts = (props.field.enumValues ?? []).map((v) => ({
        value: (props.field.type === 'number' ? Number(v) : String(v)) as string | number,
        label: props.field.enumLabels?.[String(v)] ?? String(v),
    }));
    // Advanced fields can fall back to the module-global value — offer an
    // explicit way back to inherit after a value has been picked.
    if (props.field.advanced) {
        return [{ value: INHERIT, label: 'Inherit (global)' }, ...opts];
    }
    return opts;
});

const selectValue = computed<string | number | undefined>(() => {
    if (props.field.advanced && !isSet.value) return INHERIT;
    return props.value as string | number | undefined;
});

function onSelect(value: string | number): void {
    if (props.field.advanced && value === INHERIT) {
        emit('clear');
        return;
    }
    emit('update', value);
}

function onInput(value: string | number): void {
    // A blank text input on an advanced field means "inherit" (clear the key).
    // Number inputs can't use this — MrInput coerces '' to 0 (a meaningful
    // value), so numeric overrides reset via the explicit ↺ button instead.
    if (props.field.advanced && (value === '' || value === undefined)) {
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
            :placeholder="field.advanced ? 'Inherit (global)' : undefined"
            :disabled="disabled"
            @update:model-value="onSelect"
        />

        <div v-else class="flex items-center gap-1">
            <div class="flex-1">
                <MrInput
                    :model-value="isSet ? (value as string | number) : ''"
                    :type="field.type === 'number' ? 'number' : 'text'"
                    :placeholder="field.advanced ? 'Inherit (global)' : undefined"
                    :disabled="disabled"
                    @update:model-value="onInput"
                />
            </div>
            <!-- Explicit reset-to-inherit for advanced number overrides (a blank
                 number input can't express inherit — MrInput coerces it to 0). -->
            <button
                v-if="field.advanced && isSet"
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

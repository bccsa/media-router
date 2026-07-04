<script setup lang="ts">
import { computed, ref } from 'vue';
import MrButton from './MrButton.vue';
import MrArrayItemField, { type ItemField } from './MrArrayItemField.vue';
import { matchShowWhen } from '@/utils/showWhen';

interface ItemSchema {
    type?: string;
    properties?: Record<string, unknown>;
}

const props = defineProps<{
    modelValue: unknown[];
    schema: ItemSchema;
    label?: string;
    description?: string;
    disabled?: boolean;
    /** The module's full config, used to resolve item-relative `x-showWhen` when
     *  the controlling field is inherited (item value absent → fall back here). */
    globalConfig?: Record<string, unknown>;
}>();

const emit = defineEmits<{
    'update:modelValue': [value: unknown[]];
}>();

// Fill missing fields with defaults from schema for existing items. Advanced
// (override) fields are deliberately NOT filled — an absent key means "inherit
// the module-global setting", which is the whole point of a per-item override.
const items = computed(() => {
    const raw = props.modelValue ?? [];
    if (!props.schema?.properties) return raw;
    return raw.map((item) => {
        const patched = { ...(item as Record<string, unknown>) };
        for (const [key, rawProp] of Object.entries(props.schema.properties!)) {
            const prop = rawProp as Record<string, unknown>;
            if (prop['x-advanced']) continue;
            if (patched[key] === undefined && prop.default !== undefined) {
                patched[key] = prop.default;
            }
        }
        return patched;
    });
});

interface Field extends ItemField {
    default: unknown;
    showWhen?: string;
}

const fields = computed<Field[]>(() => {
    if (!props.schema?.properties) return [];
    return Object.entries(props.schema.properties).map(([key, rawProp]) => {
        const prop = rawProp as Record<string, unknown>;
        return {
            key,
            type: (prop.type as string) ?? 'string',
            default: prop.default,
            description: (prop.description as string) ?? key,
            enumValues: prop.enum as unknown[] | undefined,
            enumLabels: prop['x-enumLabels'] as Record<string, string> | undefined,
            advanced: !!prop['x-advanced'],
            showWhen: prop['x-showWhen'] as string | undefined,
        };
    });
});

const primaryFields = computed(() => fields.value.filter((f) => !f.advanced));
const advancedFields = computed(() => fields.value.filter((f) => f.advanced));
const hasAdvanced = computed(() => advancedFields.value.length > 0);

/** Which item indices have their Advanced section expanded. */
const expanded = ref<Record<number, boolean>>({});
function toggleAdvanced(idx: number) {
    expanded.value = { ...expanded.value, [idx]: !expanded.value[idx] };
}

/**
 * `x-showWhen` evaluated against the ITEM's own value, falling back to the
 * module-global config when the controlling field is inherited on this item
 * (e.g. show `h264Profile` only when this rendition's codec — its own override
 * or the inherited global — is h264).
 */
function isVisible(field: Field, item: Record<string, unknown>): boolean {
    return matchShowWhen(field.showWhen, (key) => {
        const own = item[key];
        return own !== undefined && own !== '' ? own : props.globalConfig?.[key];
    });
}

function addItem() {
    const newItem: Record<string, unknown> = {};
    // Seed only the primary fields; advanced/override fields stay absent so a new
    // item inherits every global by default.
    for (const f of primaryFields.value) {
        newItem[f.key] = f.default ?? (f.type === 'number' ? 0 : '');
    }
    emit('update:modelValue', [...items.value, newItem]);
}

function removeItem(index: number) {
    const updated = [...items.value];
    updated.splice(index, 1);
    emit('update:modelValue', updated);
}

function updateField(index: number, key: string, value: unknown) {
    const updated = items.value.map((item, i) => {
        if (i !== index) return item;
        return { ...(item as Record<string, unknown>), [key]: value };
    });
    emit('update:modelValue', updated);
}

/** Reset an override to inherit by dropping the key from the item. */
function clearField(index: number, key: string) {
    const updated = items.value.map((item, i) => {
        if (i !== index) return item;
        const copy = { ...(item as Record<string, unknown>) };
        delete copy[key];
        return copy;
    });
    emit('update:modelValue', updated);
}
</script>

<template>
    <div class="space-y-2">
        <div class="flex items-center justify-between">
            <div>
                <span v-if="label" class="text-xs font-medium text-foreground">{{ label }}</span>
                <p v-if="description" class="text-[10px] text-muted">{{ description }}</p>
            </div>
            <MrButton size="sm" variant="secondary" :disabled="disabled" @click="addItem"
                >+ Add</MrButton
            >
        </div>

        <div
            v-for="(item, idx) in items"
            :key="idx"
            class="rounded-md p-2 space-y-1.5 bg-surface-alt border border-border-alt"
        >
            <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] font-medium text-muted"> Item {{ idx + 1 }} </span>
                <button
                    @click="removeItem(idx)"
                    :disabled="disabled"
                    class="text-[10px] px-1 rounded hover:bg-red-500/20 transition-colors text-red-400"
                >
                    Remove
                </button>
            </div>

            <template v-for="field in primaryFields" :key="field.key">
                <MrArrayItemField
                    v-if="isVisible(field, item as Record<string, unknown>)"
                    :field="field"
                    :value="(item as Record<string, unknown>)[field.key]"
                    :disabled="disabled"
                    @update="updateField(idx, field.key, $event)"
                    @clear="clearField(idx, field.key)"
                />
            </template>

            <template v-if="hasAdvanced">
                <button
                    type="button"
                    class="flex items-center gap-1 text-[10px] text-muted hover:text-foreground transition-colors pt-0.5"
                    @click="toggleAdvanced(idx)"
                >
                    <span>{{ expanded[idx] ? '▾' : '▸' }}</span>
                    <span>Advanced (per-encode overrides)</span>
                </button>
                <div
                    v-if="expanded[idx]"
                    class="space-y-1.5 pl-2 border-l border-border-alt"
                >
                    <template v-for="field in advancedFields" :key="field.key">
                        <MrArrayItemField
                            v-if="isVisible(field, item as Record<string, unknown>)"
                            :field="field"
                            :value="(item as Record<string, unknown>)[field.key]"
                            :disabled="disabled"
                            @update="updateField(idx, field.key, $event)"
                            @clear="clearField(idx, field.key)"
                        />
                    </template>
                </div>
            </template>
        </div>

        <div
            v-if="items.length === 0"
            class="text-center py-3 text-[11px] rounded-md text-muted border border-dashed border-border-alt"
        >
            No items. Click "+ Add" to create one.
        </div>
    </div>
</template>

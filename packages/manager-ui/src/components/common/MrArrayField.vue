<script setup lang="ts">
import { computed } from 'vue';
import MrInput from './MrInput.vue';
import MrSelect from './MrSelect.vue';
import MrButton from './MrButton.vue';

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
}>();

const emit = defineEmits<{
    'update:modelValue': [value: unknown[]];
}>();

// Fill missing fields with defaults from schema for existing items
const items = computed(() => {
    const raw = props.modelValue ?? [];
    if (!props.schema?.properties) return raw;
    return raw.map((item) => {
        const patched = { ...(item as Record<string, unknown>) };
        for (const [key, rawProp] of Object.entries(props.schema.properties!)) {
            const prop = rawProp as Record<string, unknown>;
            if (patched[key] === undefined && prop.default !== undefined) {
                patched[key] = prop.default;
            }
        }
        return patched;
    });
});
const fields = computed(() => {
    if (!props.schema?.properties) return [];
    return Object.entries(props.schema.properties).map(([key, rawProp]) => {
        const prop = rawProp as Record<string, unknown>;
        return {
            key,
            type: (prop.type as string) ?? 'string',
            default: prop.default,
            description: (prop.description as string) ?? key,
            enumValues: prop.enum as unknown[] | undefined,
        };
    });
});

function addItem() {
    const newItem: Record<string, unknown> = {};
    for (const f of fields.value) {
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
</script>

<template>
    <div class="space-y-2">
        <div class="flex items-center justify-between">
            <div>
                <span v-if="label" class="text-xs font-medium" :style="{ color: 'var(--text-primary)' }">{{ label }}</span>
                <p v-if="description" class="text-[10px]" :style="{ color: 'var(--text-muted)' }">{{ description }}</p>
            </div>
            <MrButton size="sm" variant="secondary" :disabled="disabled" @click="addItem">+ Add</MrButton>
        </div>

        <div v-for="(item, idx) in items" :key="idx"
             class="rounded-md p-2 space-y-1.5"
             :style="{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)' }">
            <div class="flex items-center justify-between mb-1">
                <span class="text-[10px] font-medium" :style="{ color: 'var(--text-muted)' }">
                    Item {{ idx + 1 }}
                </span>
                <button @click="removeItem(idx)" :disabled="disabled"
                        class="text-[10px] px-1 rounded hover:bg-red-500/20 transition-colors"
                        :style="{ color: '#f87171' }">
                    Remove
                </button>
            </div>

            <div v-for="field in fields" :key="field.key" class="space-y-0.5">
                <label class="text-[10px]" :style="{ color: 'var(--text-muted)' }">{{ field.description }}</label>

                <MrSelect v-if="field.enumValues"
                          :model-value="(item as Record<string, unknown>)[field.key] as string | number"
                          :options="field.enumValues.map(v => ({ value: v as string | number, label: String(v) }))"
                          :disabled="disabled"
                          @update:model-value="updateField(idx, field.key, $event)" />

                <MrInput v-else
                         :model-value="String((item as Record<string, unknown>)[field.key] ?? '')"
                         :type="field.type === 'number' ? 'number' : 'text'"
                         :disabled="disabled"
                         @update:model-value="updateField(idx, field.key, field.type === 'number' ? Number($event) : $event)" />
            </div>
        </div>

        <div v-if="items.length === 0" class="text-center py-3 text-[11px] rounded-md"
             :style="{ color: 'var(--text-muted)', border: '1px dashed var(--border-secondary)' }">
            No items. Click "+ Add" to create one.
        </div>
    </div>
</template>

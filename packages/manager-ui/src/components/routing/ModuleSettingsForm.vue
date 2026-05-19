<script setup lang="ts">
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrSlider from '@/components/common/MrSlider.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import MrArrayField from '@/components/common/MrArrayField.vue';
import type { FormField } from '@/composables/useModuleSettingsForm';

interface DeviceOption {
    value: string;
    label: string;
}

defineProps<{
    fields: FormField[];
    settings: Record<string, unknown>;
    /** Visibility predicate from `useModuleSettingsForm`. */
    isVisible: (field: FormField) => boolean;
    /** Effective enum resolver (handles x-enumBy). */
    getEnum: (field: FormField) => unknown[] | undefined;
    /** Effective max resolver (handles x-maxBy). */
    getMax: (field: FormField) => number | undefined;
    /** Device-list resolver — closure captures the deviceStore + engineId. */
    deviceOptions: (fieldKey: string, deviceType: string) => DeviceOption[];
}>();

const emit = defineEmits<{ update: [key: string, value: unknown] }>();

function onUpdate(key: string, value: unknown): void {
    emit('update', key, value);
}
</script>

<template>
    <div v-if="fields.length === 0" class="text-sm py-4 text-center text-muted">
        No configurable settings.
    </div>
    <div
        v-for="field in fields"
        :key="field.key"
        v-show="isVisible(field)"
        class="space-y-1.5"
    >
        <label class="flex items-center gap-1 text-xs font-medium text-subtle">
            {{ field.label }}
            <span
                v-if="field.liveUpdatable"
                class="text-amber-500 text-[10px] cursor-help relative group"
                >&#9889;
                <span
                    class="hidden group-hover:block absolute left-4 -top-1 w-40 p-2 rounded-md shadow-lg text-[9px] leading-relaxed bg-card border border-border text-foreground"
                    style="z-index: 9999"
                >
                    Live update — changes apply instantly without restarting the module
                </span>
            </span>
        </label>
        <p v-if="field.description" class="text-[10px] text-muted">
            {{ field.description }}
        </p>
        <!-- Read-only field (auto-detected values) -->
        <div
            v-if="field.readOnly"
            class="w-full px-2 py-1.5 text-sm rounded-md opacity-60 bg-surface-alt border border-border-alt text-muted"
        >
            {{ settings[field.key] ?? '—' }}
        </div>
        <template v-else>
            <!-- Device picker (for x-deviceType fields) -->
            <MrSelect
                v-if="field.deviceType"
                :model-value="(settings[field.key] as string) ?? ''"
                :options="deviceOptions(field.key, field.deviceType)"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Enum select (supports field-dependent options via x-enumBy) -->
            <MrSelect
                v-else-if="getEnum(field)"
                :model-value="settings[field.key] as string | number"
                :options="
                    getEnum(field)!.map((opt) => ({
                        value: (field.type === 'number' ? Number(opt) : String(opt)) as
                            | string
                            | number,
                        label: field.enumLabels?.[String(opt)] ?? String(opt),
                    }))
                "
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Array field -->
            <MrArrayField
                v-else-if="field.type === 'array' && field.items"
                :model-value="(settings[field.key] as unknown[]) ?? field.defaultValue ?? []"
                :schema="field.items"
                :disabled="field.readOnly"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Boolean toggle -->
            <MrToggle
                v-else-if="field.type === 'boolean'"
                :model-value="!!settings[field.key]"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Slider for volume/gain controls -->
            <MrSlider
                v-else-if="field.widget === 'slider'"
                :model-value="Number(settings[field.key] ?? field.defaultValue ?? 0)"
                :min="field.minimum"
                :max="
                    field.maxFrom
                        ? Number(settings[field.maxFrom] ?? field.maximum)
                        : field.maximum
                "
                :step="field.step"
                :editable="true"
                :unit="field.unit ?? '%'"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Plain number input -->
            <MrInput
                v-else-if="field.type === 'number'"
                type="number"
                :model-value="settings[field.key] as number"
                :min="field.minimum"
                :max="getMax(field)"
                @update:model-value="onUpdate(field.key, $event)"
            />
            <!-- Text input (default) -->
            <MrInput
                v-else
                type="text"
                :model-value="settings[field.key] as string"
                @update:model-value="onUpdate(field.key, $event)"
            />
        </template>
    </div>
</template>

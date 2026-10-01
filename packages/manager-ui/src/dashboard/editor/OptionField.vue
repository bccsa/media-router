<script setup lang="ts">
import MrInput from '@/components/common/MrInput.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import type { OptionDef } from '../registry';

defineProps<{ def: OptionDef; value: unknown }>();
const emit = defineEmits<{ change: [value: unknown] }>();

const num = (v: unknown) => (v === '' || v === undefined ? undefined : Number(v));
</script>

<template>
    <MrToggle v-if="def.kind === 'boolean'" :model-value="value === true" :label="def.label" @update:model-value="emit('change', $event)" />
    <MrSelect
        v-else-if="def.kind === 'select'"
        :model-value="String(value ?? '')"
        :label="def.label"
        :options="def.choices ?? []"
        @update:model-value="emit('change', $event)"
    />
    <div v-else-if="def.kind === 'color'" class="flex items-center gap-2">
        <label class="text-xs font-medium text-foreground flex-1">{{ def.label }}</label>
        <input type="color" class="w-9 h-7 rounded border border-border bg-input" :value="(value as string) || '#10b981'" @input="emit('change', ($event.target as HTMLInputElement).value)" />
        <button v-if="value" class="text-[11px] text-muted hover:underline" @click="emit('change', undefined)">Default</button>
    </div>
    <MrInput
        v-else
        :model-value="(value as string | number | undefined) ?? ''"
        :label="def.label"
        :type="def.kind === 'number' ? 'number' : 'text'"
        @update:model-value="emit('change', def.kind === 'number' ? num($event) : $event)"
    />
</template>

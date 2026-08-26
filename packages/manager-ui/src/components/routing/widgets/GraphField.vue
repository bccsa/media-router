<script setup lang="ts">
/**
 * Settings-form binding for the generic `graph` widget: resolves the plot data
 * a field's `x-graph` points at out of the module's `statusData`, and hands it
 * to `GraphWidget`.
 *
 * The lookup is the only thing here — `GraphWidget` owns the plotting and the
 * plugin owns the domain (ADR-0007). Split out of `ModuleSettingsForm.vue` so
 * that file stays a field switchboard rather than growing a per-widget data
 * resolver for every display widget that follows this one.
 */
import { computed } from 'vue';
import GraphWidget from '@/components/routing/widgets/GraphWidget.vue';
import type { FormField } from '@/composables/useModuleSettingsForm';
import { isStatusGraph } from '@/utils/statusGraph';
import { useEngineStore } from '@/stores/engines';

const props = defineProps<{
    field: FormField;
    engineId: string;
    moduleId: string;
}>();

const engineStore = useEngineStore();

/**
 * The status field the widget's `x-graph` points at. The plugin computes and
 * publishes it (`setStatusGraph`); this only reads it. Undefined until the
 * first publish, or when the field holds something that isn't graph data.
 */
const data = computed(() => {
    const source = props.field.graph;
    if (!source) return undefined;
    const value = engineStore.getEngine(props.engineId)?.modules[props.moduleId]?.statusData?.[
        source.section
    ]?.[source.key];
    return isStatusGraph(value) ? value : undefined;
});
</script>

<template>
    <GraphWidget :data="data" :height="field.graph?.height" />
</template>

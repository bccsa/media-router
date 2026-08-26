import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { ModuleState } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { matchShowWhen } from '@/utils/showWhen';
import { stripDisplayFields, type GraphSource } from '@/utils/displayWidgets';

/** JSON Schema property shape with media-router extensions. */
interface SchemaProperty {
    type?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    'x-live'?: boolean;
    'x-liveUpdatable'?: boolean;
    'x-deviceType'?: string;
    'x-optionsFrom'?: string;
    'x-widget'?: string;
    'x-graph'?: GraphSource;
    'x-step'?: number;
    'x-maxFrom'?: string;
    'x-enumBy'?: { field: string; map: Record<string, unknown[]> };
    'x-enumLabels'?: Record<string, string>;
    'x-maxBy'?: { field: string; map: Record<string, number> };
    'x-readOnly'?: boolean;
    'x-showWhen'?: string;
    'x-unit'?: string;
    'x-debounceMs'?: number;
    items?: { type?: string; properties?: Record<string, unknown> };
}

/** Render-ready field descriptor consumed by `ModuleSettingsForm.vue`. */
export interface FormField {
    key: string;
    type: string;
    label: string;
    description: string;
    defaultValue: unknown;
    enumValues?: unknown[];
    enumLabels?: Record<string, string>;
    liveUpdatable: boolean;
    deviceType?: string;
    /** Key into the module's pushed `fieldOptions` for a discovery-driven multi-select. */
    optionsFrom?: string;
    widget?: string;
    /** `x-graph` — where a `graph` widget reads its plot data from. */
    graph?: GraphSource;
    minimum?: number;
    maximum?: number;
    step?: number;
    maxFrom?: string;
    enumBy?: { field: string; map: Record<string, unknown[]> };
    maxBy?: { field: string; map: Record<string, number> };
    readOnly?: boolean;
    items?: { type?: string; properties?: Record<string, unknown> };
    showWhen?: string;
    unit?: string;
    debounceMs?: number;
}

export interface ModuleSettingsFormOptions {
    engineId: Ref<string>;
    moduleId: Ref<string>;
    module: ComputedRef<ModuleState | undefined>;
}

/**
 * State machinery for ModuleSettingsPanel — schema-driven `formFields`,
 * local-settings buffer, and the throttle/debounce live-update pipeline.
 *
 * Two strategies per field for live updates:
 *   - throttle (default 50ms): fire first update immediately, coalesce the
 *     rest, flush once the window closes. Good for volume / fast interactive
 *     sliders where the backend takes updates cheaply.
 *   - debounce (opt-in via `x-debounceMs`): only fire after the user has
 *     stopped changing the value for N ms. Good for expensive sliders
 *     (video bitrate: the encoder reconfigures on each change).
 */
export function useModuleSettingsForm(opts: ModuleSettingsFormOptions) {
    const DEFAULT_THROTTLE_MS = 50;

    const formFields = computed<FormField[]>(() => {
        const schema = opts.module.value?.configSchema as
            | { properties?: Record<string, SchemaProperty> }
            | undefined;
        if (!schema?.properties) return [];
        const schemaProps = schema.properties;
        // Plugins may narrow the live set based on current config (e.g. video
        // encoder drops `bitrate` for AV1). Prefer the runtime list; fall back
        // to the schema flag when the engine hasn't reported one yet.
        const runtimeLive = opts.module.value?.liveUpdatableParams;
        return Object.entries(schemaProps).map(([key, prop]) => ({
            key,
            type: prop.type ?? 'string',
            label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase()),
            description: prop.description ?? '',
            defaultValue: prop.default,
            enumValues: prop.enum,
            enumLabels: prop['x-enumLabels'],
            liveUpdatable: runtimeLive
                ? runtimeLive.includes(key)
                : !!prop['x-live'] || !!prop['x-liveUpdatable'],
            deviceType: prop['x-deviceType'],
            optionsFrom: prop['x-optionsFrom'],
            widget: prop['x-widget'],
            graph: prop['x-graph'],
            minimum: prop.minimum,
            maximum: prop.maximum,
            step: prop['x-step'],
            maxFrom: prop['x-maxFrom'],
            enumBy: prop['x-enumBy'],
            maxBy: prop['x-maxBy'],
            readOnly: !!prop['x-readOnly'],
            showWhen: prop['x-showWhen'],
            unit: prop['x-unit'],
            debounceMs: prop['x-debounceMs'],
            items: prop.items as FormField['items'],
        }));
    });

    const localSettings = ref<Record<string, unknown>>({});

    watch(
        () => opts.module.value?.settings,
        (settings) => {
            if (!settings) return;
            const defaults: Record<string, unknown> = {};
            for (const f of formFields.value) {
                if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
            }
            // Stripped on the way IN too: a seeded virtual key survives to Apply.
            const merged = { ...defaults, ...settings };
            localSettings.value = stripDisplayFields(formFields.value, merged);
        },
        { immediate: true, deep: true },
    );

    /** Visibility rule for `x-showWhen`, resolved against the live settings. */
    function isFieldVisible(field: FormField): boolean {
        return matchShowWhen(field.showWhen, (key) => localSettings.value[key]);
    }

    /** Resolve effective enum values — checks x-enumBy first, falls back to plain enum. */
    function getFieldEnum(field: FormField): unknown[] | undefined {
        if (field.enumBy) {
            const val = String(localSettings.value[field.enumBy.field] ?? '');
            return field.enumBy.map[val] ?? field.enumValues;
        }
        return field.enumValues;
    }

    /** Resolve effective maximum — checks x-maxBy first, falls back to plain maximum. */
    function getFieldMax(field: FormField): number | undefined {
        if (field.maxBy) {
            const val = String(localSettings.value[field.maxBy.field] ?? '');
            return field.maxBy.map[val] ?? field.maximum;
        }
        return field.maximum;
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let throttlePending: { key: string; value: unknown } | null = null;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function sendLiveUpdate(key: string, value: unknown): void {
        patch.moduleSetting(opts.engineId.value, opts.moduleId.value, key, value);
    }

    function updateSetting(key: string, value: unknown): void {
        localSettings.value = { ...localSettings.value, [key]: value };
        // Clamp dependent fields when a controlling field changes (e.g. codec → channels max)
        for (const f of formFields.value) {
            if (!f.maxBy) continue;
            const max = getFieldMax(f);
            const cur = Number(localSettings.value[f.key] ?? 0);
            if (max != null && cur > max) {
                localSettings.value = { ...localSettings.value, [f.key]: max };
            }
        }
        const field = formFields.value.find((f) => f.key === key);
        if (!field?.liveUpdatable) return;

        if (field.debounceMs && field.debounceMs > 0) {
            const existing = debounceTimers.get(key);
            if (existing) clearTimeout(existing);
            debounceTimers.set(
                key,
                setTimeout(() => {
                    debounceTimers.delete(key);
                    sendLiveUpdate(key, localSettings.value[key]);
                }, field.debounceMs),
            );
            return;
        }

        throttlePending = { key, value };
        if (!throttleTimer) {
            sendLiveUpdate(key, value);
            // Clear pending after the leading-edge send so a no-further-update
            // window doesn't trail-edge re-send the same value.
            throttlePending = null;
            throttleTimer = setTimeout(() => {
                throttleTimer = null;
                if (throttlePending) {
                    sendLiveUpdate(throttlePending.key, throttlePending.value);
                    throttlePending = null;
                }
            }, DEFAULT_THROTTLE_MS);
        }
    }

    onUnmounted(() => {
        if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
        }
        if (throttlePending) {
            sendLiveUpdate(throttlePending.key, throttlePending.value);
            throttlePending = null;
        }
        // Flush any pending debounced values on unmount so the user doesn't lose
        // changes they made right before closing the panel.
        for (const [key, timer] of debounceTimers) {
            clearTimeout(timer);
            sendLiveUpdate(key, localSettings.value[key]);
        }
        debounceTimers.clear();
    });

    function applyAll(): void {
        // Belt and braces with the hydration strip above — this is the gate.
        patch.moduleSettings(
            opts.engineId.value,
            opts.moduleId.value,
            stripDisplayFields(formFields.value, localSettings.value),
        );
    }

    return {
        formFields,
        localSettings,
        isFieldVisible,
        getFieldEnum,
        getFieldMax,
        updateSetting,
        applyAll,
    };
}

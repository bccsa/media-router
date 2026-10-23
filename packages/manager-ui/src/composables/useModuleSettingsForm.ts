import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import * as shared from '@media-router/shared-types';
import * as wire from '@media-router/shared-types/browser';
import type { ModuleState } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { matchShowWhen } from '@/utils/showWhen';
import { stripDisplayFields, type GraphSource } from '@/utils/displayWidgets';
import { fieldLabel } from '@/utils/fieldLabel';
import type { EntryRule } from '@/utils/entryRules';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { diffValues } = shared;
const { settingMaximum } = wire;

const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

type SchemaProps = Record<string, Record<string, unknown>>;

/** `x-widget` values a manifest may declare; anything else renders by the field's type. */
export type SettingsWidget = 'slider' | 'textarea' | 'imageUpload' | 'graph' | 'pidTrim';

/** The per-entry schema of an object (map) field, e.g. the `pidTrim` widget's ms bounds. */
export interface MapEntrySchema {
    type?: string;
    minimum?: number;
    maximum?: number;
}

/** JSON Schema property shape with media-router extensions. */
interface SchemaProperty {
    type?: string;
    /** Field heading; falls back to the humanized key. */
    title?: string;
    /** Help text shown in the field's "?" popover. */
    description?: string;
    default?: unknown;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    additionalProperties?: boolean | MapEntrySchema;
    'x-live'?: boolean;
    'x-liveUpdatable'?: boolean;
    'x-deviceType'?: string;
    'x-optionsFrom'?: string;
    'x-widget'?: SettingsWidget;
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
    /** Key into the module's pushed `fieldOptions`: a multi-select's choices, a `pidTrim`'s rows. */
    optionsFrom?: string;
    widget?: SettingsWidget;
    /** An object field's per-entry schema; apart from `items` so a map never takes the array path. */
    additionalProperties?: MapEntrySchema;
    /** `x-graph` — where a `graph` widget reads its plot data from. */
    graph?: GraphSource;
    minimum?: number;
    maximum?: number;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
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

    /** The schema's properties as declared, which the maximum rule reads. */
    const schemaProps = computed(() => {
        const schema = opts.module.value?.configSchema as { properties?: SchemaProps } | undefined;
        return schema?.properties ?? {};
    });

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
            label: fieldLabel(key, prop),
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
            pattern: prop.pattern,
            minLength: prop.minLength,
            maxLength: prop.maxLength,
            step: prop['x-step'],
            maxFrom: prop['x-maxFrom'],
            enumBy: prop['x-enumBy'],
            maxBy: prop['x-maxBy'],
            readOnly: !!prop['x-readOnly'],
            showWhen: prop['x-showWhen'],
            unit: prop['x-unit'],
            debounceMs: prop['x-debounceMs'],
            items: prop.items as FormField['items'],
            additionalProperties:
                prop.additionalProperties && typeof prop.additionalProperties === 'object'
                    ? prop.additionalProperties
                    : undefined,
        }));
    });

    const localSettings = ref<Record<string, unknown>>({});
    // The stored settings the panel copy was last in step with, and whose. A copy: a deep watch on
    // settings changed in place is handed the same object as old and new (B-105).
    let synced: { id: string; settings: Record<string, unknown> } | undefined;

    watch(
        () => opts.module.value?.settings,
        (settings) => {
            if (!settings) return;
            const defaults: Record<string, unknown> = {};
            for (const f of formFields.value) {
                if (f.defaultValue !== undefined) defaults[f.key] = f.defaultValue;
            }
            // Stripped on the way IN too: a seeded virtual key survives to Apply.
            const stored = jsonCopy(
                stripDisplayFields(formFields.value, { ...defaults, ...settings }),
            );
            // Another module's settings replace the copy whole, unsaved changes and all, as before.
            const id = `${opts.engineId.value}/${opts.moduleId.value}`;
            localSettings.value = synced?.id === id ? keepChanges(stored, synced.settings) : stored;
            synced = { id, settings: jsonCopy(stored) };
        },
        { immediate: true, deep: true },
    );

    /** The stored settings with each value the operator changed in the panel since `before` kept. */
    function keepChanges(
        stored: Record<string, unknown>,
        before: Record<string, unknown>,
    ): Record<string, unknown> {
        const next = { ...stored };
        const changed = new Set<string>();
        for (const [key, value] of Object.entries(localSettings.value)) {
            if (diffValues(before[key], value).length === 0) continue;
            next[key] = value;
            changed.add(key);
        }
        // A dependent another writer moved stays within the maximum the operator set here.
        return clampDependents(next, changed);
    }

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

    /** Effective maximum by the manager's rule (shared-types' `settingMaximum`) on the panel's copy. */
    function getFieldMax(field: FormField): number | undefined {
        return settingMaximum(schemaProps.value[field.key] ?? {}, localSettings.value);
    }

    /** Brings each setting whose maximum one of `sources` sets (x-maxFrom, x-maxBy) down to it. */
    function clampDependents(
        settings: Record<string, unknown>,
        sources: ReadonlySet<string>,
    ): Record<string, unknown> {
        let next = settings;
        for (const f of formFields.value) {
            if (![f.maxFrom, f.maxBy?.field].some((s) => !!s && sources.has(s))) continue;
            const max = settingMaximum(schemaProps.value[f.key] ?? {}, next);
            if (max !== undefined && Number(next[f.key] ?? 0) > max) {
                next = { ...next, [f.key]: max };
            }
        }
        return next;
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let throttlePending: { key: string; value: unknown } | null = null;
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function sendLiveUpdate(key: string, value: unknown): void {
        patch.moduleSetting(opts.engineId.value, opts.moduleId.value, key, value);
    }

    function updateSetting(key: string, value: unknown): void {
        // A controlling field's change brings its dependents within it (codec → bitrate, Volume
        // Range → volume), in the copy Save writes.
        const next = { ...localSettings.value, [key]: value };
        localSettings.value = clampDependents(next, new Set([key]));
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

/** A typed field's rule (B-104): its type, bounds with the effective maximum, unit, pattern and lengths. */
export function fieldRule(field: FormField, max: number | undefined): EntryRule {
    return {
        type: field.type,
        min: field.minimum,
        max,
        unit: field.unit,
        pattern: field.pattern,
        minLength: field.minLength,
        maxLength: field.maxLength,
    };
}

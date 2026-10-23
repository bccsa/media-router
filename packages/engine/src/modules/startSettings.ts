import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { settingMaximum } from '@media-router/shared-types';

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

type SchemaProps = Record<string, Record<string, unknown>>;

/** ajv keywords whose error a start fixes by bringing the value to `params.limit`. */
const BOUNDS = new Set(['maximum', 'minimum']);

/** Per plugin schema, its validators with moved maxima, by those maxima: ajv keeps every compile. */
const movedValidators = new WeakMap<object, Map<string, ValidateFunction>>();

/**
 * A validator of the plugin's schema with each maximum as the manager reads it from these settings
 * (x-maxFrom, x-maxBy), so a start judges a value as the manager's write check does (B-103).
 */
function settingsValidator(
    schema: Record<string, unknown>,
    settings: Record<string, unknown>,
): ValidateFunction {
    const props = (schema.properties ?? {}) as SchemaProps;
    const moved: Array<[string, number]> = [];
    for (const [key, prop] of Object.entries(props)) {
        const maximum = settingMaximum(prop, settings);
        if (maximum !== undefined && maximum !== prop.maximum) moved.push([key, maximum]);
    }
    if (moved.length === 0) return ajv.compile(schema);
    const byMaxima = movedValidators.get(schema) ?? new Map<string, ValidateFunction>();
    movedValidators.set(schema, byMaxima);
    const id = JSON.stringify(moved);
    let validate = byMaxima.get(id);
    if (!validate) {
        const properties = { ...props };
        for (const [key, maximum] of moved) properties[key] = { ...props[key], maximum };
        validate = ajv.compile({ ...schema, properties });
        byMaxima.set(id, validate);
    }
    return validate;
}

/** What a start's check found and changed, for its log line. */
export interface StartSettingsFixes {
    /** ajv's errors: `/path message`. */
    errors: string[];
    /** Each number brought to the bound it was past: `key old -> new`. */
    clamped: string[];
    /** Each other invalid value set to its default: `key -> default`. */
    reset: string[];
}

/**
 * Checks a module's settings at its start, in place (B-103): a top-level number past its minimum or
 * its effective maximum is brought to that bound, any other invalid top-level value is reset to its
 * default. A nested value (an array item's) is logged only, as before. Null when the settings pass.
 */
export function checkStartSettings(
    schema: Record<string, unknown>,
    settings: Record<string, unknown>,
): StartSettingsFixes | null {
    const validate = settingsValidator(schema, settings);
    validate(settings);
    const errors = validate.errors ?? [];
    if (errors.length === 0) return null;
    const props = (schema.properties ?? {}) as SchemaProps;
    const byKey = new Map<string, ErrorObject[]>();
    for (const err of errors) {
        const key = err.instancePath.slice(1);
        if (props[key]) byKey.set(key, [...(byKey.get(key) ?? []), err]);
    }
    const fixes: StartSettingsFixes = {
        errors: errors.map((e) => `${e.instancePath || '/'} ${e.message}`),
        clamped: [],
        reset: [],
    };
    for (const [key, [first, ...more]] of byKey) {
        if (more.length === 0 && BOUNDS.has(first.keyword)) {
            const { limit } = first.params as { limit: number };
            fixes.clamped.push(`${key} ${String(settings[key])} -> ${limit}`);
            settings[key] = limit;
        } else if (props[key].default !== undefined) {
            settings[key] = props[key].default;
            fixes.reset.push(`${key} -> ${JSON.stringify(props[key].default)}`);
        }
    }
    return fixes;
}

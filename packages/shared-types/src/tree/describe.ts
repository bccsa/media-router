import type { PatchOp } from '../index.js';
import { dropUndefined } from './object.js';

/** What a value is and what a client may do with it (served at /meta + path). */
export interface ValueDescriptor {
    access: 'read' | 'write';
    /** Writable values only: applied at once, or on the module's next restart. */
    apply?: 'live' | 'restart';
    type?: string;
    label?: string;
    description?: string;
    unit?: string;
    min?: number;
    max?: number;
    step?: number;
    enum?: unknown[];
    enumLabels?: Record<string, string>;
    widget?: string;
    format?: string;
    debounceMs?: number;
}

type SchemaProp = Record<string, unknown>;
type StatusSectionLike = { id: string; fields: Array<{ key: string; label: string; unit?: string; format?: string }> };

/** The module fields `describeModuleValue` reads. */
export interface DescribableModule {
    settings?: Record<string, unknown>;
    configSchema?: unknown;
    liveUpdatableParams?: string[];
    statusSections?: StatusSectionLike[];
    dynamicStatusSections?: StatusSectionLike[];
    statusData?: Record<string, Record<string, unknown>>;
}

/** Module fields a client may write besides `settings/<key>`. */
const WRITABLE_FIELDS: Record<string, ValueDescriptor> = {
    enabled: { access: 'write', apply: 'live', type: 'boolean', label: 'Enabled' },
    displayName: { access: 'write', apply: 'live', type: 'string', label: 'Name' },
    position: { access: 'write', apply: 'live', type: 'object' },
    size: { access: 'write', apply: 'live', type: 'object' },
    focused: { access: 'write', apply: 'live', type: 'boolean' },
};

/** Display-only schema widgets hold no value (ADR-0007 amendment). */
const DISPLAY_WIDGETS = new Set(['graph']);

function schemaProps(mod: DescribableModule): Record<string, SchemaProp> {
    const schema = mod.configSchema as { properties?: Record<string, SchemaProp> } | undefined;
    return schema?.properties ?? {};
}

function num(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function describeSetting(mod: DescribableModule, key: string): ValueDescriptor | null {
    const prop = schemaProps(mod)[key];
    if (!prop) return null;
    const settings = mod.settings ?? {};
    const readOnly = prop['x-readOnly'] === true || DISPLAY_WIDGETS.has(prop['x-widget'] as string);
    const live = mod.liveUpdatableParams
        ? mod.liveUpdatableParams.includes(key)
        : prop['x-live'] === true || prop['x-liveUpdatable'] === true;
    const maxFrom = prop['x-maxFrom'] as string | undefined;
    const maxBy = prop['x-maxBy'] as { field: string; map: Record<string, number> } | undefined;
    const enumBy = prop['x-enumBy'] as { field: string; map: Record<string, unknown[]> } | undefined;
    const max =
        (maxFrom ? num(settings[maxFrom]) : undefined) ??
        (maxBy ? num(maxBy.map[String(settings[maxBy.field] ?? '')]) : undefined) ??
        num(prop.maximum);
    const d: ValueDescriptor = {
        access: readOnly ? 'read' : 'write',
        type: prop.type as string | undefined,
        label: (prop.title as string | undefined) ?? key,
        description: prop.description as string | undefined,
        unit: prop['x-unit'] as string | undefined,
        min: num(prop.minimum),
        max,
        step: num(prop['x-step']),
        enum: (enumBy ? enumBy.map[String(settings[enumBy.field] ?? '')] : undefined) ?? (prop.enum as unknown[] | undefined),
        enumLabels: prop['x-enumLabels'] as Record<string, string> | undefined,
        widget: prop['x-widget'] as string | undefined,
        debounceMs: num(prop['x-debounceMs']),
    };
    if (!readOnly) d.apply = live ? 'live' : 'restart';
    return dropUndefined(d);
}

function describeStatus(mod: DescribableModule, section: string, key: string): ValueDescriptor {
    const sections = [...(mod.statusSections ?? []), ...(mod.dynamicStatusSections ?? [])];
    const field = sections.find((s) => s.id === section)?.fields.find((f) => f.key === key);
    const value = mod.statusData?.[section]?.[key];
    return dropUndefined({
        access: 'read',
        type: value === undefined ? undefined : typeof value,
        label: field?.label ?? key,
        unit: field?.unit,
        format: field?.format,
    });
}


/**
 * Describe a value inside one module node, `rel` being its path below the
 * module. Null = no such value (an undeclared setting, an unknown field).
 */
export function describeModuleValue(mod: DescribableModule, rel: readonly string[]): ValueDescriptor | null {
    const [field, a, b] = rel;
    if (field === 'settings') return rel.length === 2 ? describeSetting(mod, a) : null;
    if (field === 'statusData' && rel.length === 3) return describeStatus(mod, a, b);
    if (rel.length === 1 && WRITABLE_FIELDS[field]) return { ...WRITABLE_FIELDS[field] };
    return rel.length >= 1 ? { access: 'read' } : null;
}

function typeOk(type: string | undefined, value: unknown): boolean {
    switch (type) {
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'string':
            return typeof value === 'string';
        case 'array':
            return Array.isArray(value);
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value);
        default:
            return true;
    }
}

/** Why a write op may not apply to the described value; null = allowed. */
export function checkWrite(desc: ValueDescriptor | null, op: PatchOp): string | null {
    if (!desc) return 'unknown value';
    if (desc.access !== 'write') return 'read-only';
    if (op.op === 'remove') return 'not removable';
    const v = op.value;
    if (!typeOk(desc.type, v)) return `expected ${desc.type}`;
    if (typeof v === 'number') {
        if (desc.min !== undefined && v < desc.min) return `below minimum ${desc.min}`;
        if (desc.max !== undefined && v > desc.max) return `above maximum ${desc.max}`;
    }
    if (desc.enum) {
        // Numeric enums arrive as numbers or strings depending on the schema.
        const allowed = new Set(desc.enum.map((e) => String(e)));
        const items = Array.isArray(v) ? v : [v];
        if (items.some((item) => !allowed.has(String(item)))) return 'not an allowed option';
    }
    return null;
}

/**
 * Per-op write checks for one batch: each module is checked against a working
 * copy, so a later op sees the batch's earlier settings (`x-maxFrom`, …).
 */
export class ModuleWriteCheck {
    private working = new Map<string, DescribableModule>();

    constructor(private readonly lookup: (id: string) => DescribableModule | undefined) {}

    /** `rel` is the path below the module; null = allowed. */
    check(id: string, rel: readonly string[], op: PatchOp): string | null {
        let mod = this.working.get(id);
        if (!mod) {
            const node = this.lookup(id);
            if (!node) return 'unknown module';
            mod = { ...node, settings: { ...(node.settings ?? {}) } };
            this.working.set(id, mod);
        }
        const reason = checkWrite(describeModuleValue(mod, rel), op);
        if (!reason && rel[0] === 'settings' && rel.length === 2) mod.settings![rel[1]] = op.value;
        return reason;
    }
}

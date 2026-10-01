import type { PatchOp } from '../index.js';
import { dropUndefined } from './object.js';
import { getAt } from './apply.js';
import { splitPath } from './paths.js';
import { carriesAudio } from '../carriesAudio.js';
import { VU_BLOCKS } from '../vu.js';

/** What a value is and what a client may do with it (served at `/meta` + its path). */
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
type StatusSectionLike = { id: string; fields: Array<{ key: string; label: string; unit?: string; format?: string; type?: string }> };

/** The module fields `describeModuleValue` reads. */
export interface DescribableModule {
    settings?: Record<string, unknown>;
    configSchema?: unknown;
    liveUpdatableParams?: string[];
    statusSections?: StatusSectionLike[];
    dynamicStatusSections?: StatusSectionLike[];
    statusData?: Record<string, Record<string, unknown>>;
    ports?: Array<{ streamType?: string; acceptsAnyTs?: boolean }>;
}

/** A module's levels (`vu`): per channel 0–VU_BLOCKS blocks, for every module that carries audio. */
const LEVELS: ValueDescriptor = { access: 'read', type: 'array', min: 0, max: VU_BLOCKS, label: 'Levels' };

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

function statusSectionsOf(mod: DescribableModule): StatusSectionLike[] {
    return [...(mod.statusSections ?? []), ...(mod.dynamicStatusSections ?? [])];
}

/** Declared status fields only; the type as the plugin declares it, so it is known with the router offline. */
function describeStatus(mod: DescribableModule, section: string, key: string): ValueDescriptor {
    const field = statusSectionsOf(mod).find((s) => s.id === section)?.fields.find((f) => f.key === key);
    return dropUndefined({ access: 'read', label: field?.label ?? key, unit: field?.unit, format: field?.format, type: field?.type });
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
    if (rel.length === 1 && field === 'vu' && carriesAudio(mod.ports)) return { ...LEVELS };
    return rel.length >= 1 ? { access: 'read' } : null;
}

/** A module's `/meta` node: the writable module fields this server takes, settings, status. */
export interface ModuleMeta {
    enabled?: ValueDescriptor;
    displayName?: ValueDescriptor;
    position?: ValueDescriptor;
    size?: ValueDescriptor;
    focused?: ValueDescriptor;
    settings: Record<string, ValueDescriptor>;
    statusData: Record<string, Record<string, ValueDescriptor>>;
    /** Present when the module carries audio, so it reports levels. */
    vu?: ValueDescriptor;
}

/**
 * Every described value of one module, keyed like the module node — its
 * `/meta` node (ADR-0024). `writable` = the module fields this server takes
 * writes to (a router: `enabled` only).
 */
export function describeModule(
    mod: DescribableModule,
    writable: readonly string[] = Object.keys(WRITABLE_FIELDS),
): ModuleMeta {
    const fields: Record<string, ValueDescriptor> = {};
    for (const f of writable) if (WRITABLE_FIELDS[f]) fields[f] = { ...WRITABLE_FIELDS[f] };
    const settings: Record<string, ValueDescriptor> = {};
    for (const key of Object.keys(schemaProps(mod))) {
        const d = describeSetting(mod, key);
        if (d) settings[key] = d;
    }
    const statusData: Record<string, Record<string, ValueDescriptor>> = {};
    for (const s of statusSectionsOf(mod)) {
        const section = (statusData[s.id] ??= {});
        for (const f of s.fields) section[f.key] = describeStatus(mod, s.id, f.key);
    }
    return { ...fields, settings, statusData, ...(carriesAudio(mod.ports) ? { vu: { ...LEVELS } } : {}) };
}

/**
 * Resolve a path below one router's `/meta` node — `info/…`, `modules/<id>/…`,
 * `modules`, or all of it — building only what the path needs.
 */
export function metaAt(
    rest: readonly string[],
    info: Readonly<Record<string, ValueDescriptor>>,
    moduleIds: () => string[],
    moduleMeta: (id: string) => ModuleMeta | undefined,
): unknown {
    const [branch, id, ...deeper] = rest;
    if (branch === 'info') return getAt(info, rest.slice(1));
    if (branch === 'modules' && id !== undefined) return getAt(moduleMeta(id), deeper);
    const modules = () => Object.fromEntries(moduleIds().map((m) => [m, moduleMeta(m)]));
    if (branch === 'modules') return modules();
    return branch === undefined ? { info, modules: modules() } : undefined;
}

/**
 * Modules a batch of `/modules/<id>/…` ops touches, whose descriptors may
 * have changed; `'all'` when an op replaces the root or the whole `/modules`
 * branch. With `fields`, only ops on those module fields (or on the whole
 * module) count.
 */
export function touchedModules(ops: readonly PatchOp[], fields?: readonly string[]): Set<string> | 'all' {
    const ids = new Set<string>();
    for (const op of ops) {
        const [branch, id, field] = splitPath(op.path);
        if (branch === undefined || (branch === 'modules' && id === undefined)) return 'all';
        if (branch !== 'modules') continue;
        if (!fields || field === undefined || fields.includes(field)) ids.add(id);
    }
    return ids;
}

const RUNNING: ValueDescriptor = { access: 'write', apply: 'live', type: 'boolean', label: 'Running' };
/** A router's writable info, `/meta/info` on its own tree. */
export const ROUTER_INFO_META: Readonly<Record<string, ValueDescriptor>> = { running: RUNNING };
/** An engine's writable info on the manager, `/meta/engines/<id>/info`. */
export const ENGINE_INFO_META: Readonly<Record<string, ValueDescriptor>> = {
    running: RUNNING,
    name: { access: 'write', apply: 'live', type: 'string', label: 'Name' },
    activeProfile: { access: 'write', apply: 'live', type: 'string', label: 'Active profile' },
    groupId: { access: 'write', apply: 'live', type: 'string', label: 'Group' },
    sortOrder: { access: 'write', apply: 'live', type: 'integer', label: 'Sort order', min: 0 },
};

/** Module fields whose runtime value changes that module's descriptors. */
export const META_RUNTIME_FIELDS = ['liveUpdatableParams', 'dynamicStatusSections'];

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

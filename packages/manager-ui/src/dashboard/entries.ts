import type { ModuleMeta, ValueDescriptor } from '@media-router/shared-types';
import * as wire from '@media-router/shared-types/browser';
import { routerRelative } from './paths';

export type EntryKind = 'setting' | 'status' | 'state' | 'vu' | 'field' | 'router';

/** A value a widget can be tied to, as the picker offers it. */
export interface ValueEntry {
    /** Router-relative on a router dashboard, absolute on a manager dashboard. */
    path: string;
    label: string;
    kind: EntryKind;
    desc: ValueDescriptor;
}

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { MODULE_HEALTH, VU_BLOCKS } = wire;
export const HEALTH: readonly string[] = MODULE_HEALTH;

const READ_BOOL: ValueDescriptor = { access: 'read', type: 'boolean' };
const PERCENT = (label: string): ValueDescriptor => ({ access: 'read', type: 'number', unit: '%', min: 0, max: 100, label });

/** Descriptors for values `/meta` doesn't describe, by their path below a router. */
const BUILTIN: Record<string, ValueDescriptor> = {
    health: { access: 'read', type: 'string', enum: [...HEALTH], label: 'Health' },
    running: { ...READ_BOOL, label: 'Running' },
    pendingRestart: { ...READ_BOOL, label: 'Restart pending' },
    vu: { access: 'read', type: 'array', min: 0, max: VU_BLOCKS, label: 'Levels' },
    'info/name': { access: 'read', type: 'string', label: 'Name' },
    'info/hostname': { access: 'read', type: 'string', label: 'Hostname' },
    'info/ips': { access: 'read', type: 'array', label: 'IP addresses' },
    'info/buildNumber': { access: 'read', type: 'string', label: 'Build' },
    'system/cpu': PERCENT('CPU'),
    'system/mem': PERCENT('Memory'),
    'system/temp': { access: 'read', type: 'number', unit: '°C', min: 0, max: 100, label: 'Temperature' },
};

/** A built-in descriptor for a path, when `/meta` has none. */
export function builtinDescriptor(path: string): ValueDescriptor | undefined {
    const rel = routerRelative(path).slice(1);
    const moduleField = /^modules\/[^/]+\/([^/]+)$/.exec(rel);
    return BUILTIN[moduleField ? moduleField[1] : rel];
}

function inferType(sample: unknown): string | undefined {
    if (typeof sample === 'number') return 'number';
    if (typeof sample === 'boolean') return 'boolean';
    if (typeof sample === 'string') return 'string';
    return Array.isArray(sample) ? 'array' : undefined;
}

/**
 * Everything of one module a widget can bind (`base` = the module's path):
 * settings and status fields from its `/meta` node, its run state, `enabled`
 * where writable, and levels when it reports them.
 */
export function moduleEntries(base: string, meta: ModuleMeta | undefined, node: Record<string, any> | undefined): ValueEntry[] {
    const out: ValueEntry[] = [];
    for (const [key, desc] of Object.entries(meta?.settings ?? {})) {
        out.push({ path: `${base}/settings/${key}`, label: desc.label ?? key, kind: 'setting', desc });
    }
    for (const [section, fields] of Object.entries(meta?.statusData ?? {})) {
        for (const [key, d] of Object.entries(fields)) {
            const desc = d.type ? d : { ...d, type: inferType(node?.statusData?.[section]?.[key]) };
            out.push({ path: `${base}/statusData/${section}/${key}`, label: d.label ?? key, kind: 'status', desc });
        }
    }
    for (const field of ['health', 'running', 'pendingRestart']) {
        out.push({ path: `${base}/${field}`, label: BUILTIN[field].label!, kind: 'state', desc: BUILTIN[field] });
    }
    if (meta?.enabled) out.push({ path: `${base}/enabled`, label: 'Enabled', kind: 'field', desc: meta.enabled });
    // Levels where `/meta` says the module has them (it carries audio), stopped or silent ones too.
    if (meta?.vu) {
        out.push({ path: `${base}/vu`, label: 'Levels', kind: 'vu', desc: meta.vu });
    }
    return out;
}

/** The router's own values (`base` = '' on a router dashboard, `/engines/<id>` on a manager one). */
export function routerEntries(base: string, runningDesc: ValueDescriptor | undefined): ValueEntry[] {
    const out: ValueEntry[] = [];
    if (runningDesc) out.push({ path: `${base}/info/running`, label: 'Running', kind: 'router', desc: runningDesc });
    for (const key of ['info/name', 'info/hostname', 'info/ips', 'info/buildNumber', 'system/cpu', 'system/mem', 'system/temp']) {
        out.push({ path: `${base}/${key}`, label: BUILTIN[key].label!, kind: 'router', desc: BUILTIN[key] });
    }
    return out;
}

import type { PatchOp } from './index.js';

// Interlocks (exclusive mute): at most one member live. A router keeps them
// itself, for every write from any source, and reports the mutes (ADR-0028);
// the manager applies the same rules only for routers too old to.

type Modules = Record<string, { settings?: Record<string, unknown> } | undefined>;
type Groups = ReadonlyArray<{ members: readonly string[] }>;

const AUDIO_ENABLED = /^\/modules\/([^/]+)\/settings\/audioEnabled$/;
const mute = (id: string): PatchOp => ({ op: 'replace', path: `/modules/${id}/settings/audioEnabled`, value: false });
const live = (modules: Modules, id: string) => {
    const settings = modules[id]?.settings;
    return !!settings && settings.audioEnabled !== false;
};

/** Unmuting `moduleId` mutes every other live member of its interlock: those mutes. */
export function unmuteCascade(modules: Modules, interlocks: Groups, moduleId: string, isLive = (id: string) => live(modules, id)): PatchOp[] {
    const group = interlocks.find((g) => g.members.includes(moduleId));
    return group ? group.members.filter((id) => id !== moduleId && isLive(id)).map(mute) : [];
}

/**
 * A batch of writes with each unmute's mutes put before it (never a moment
 * with two live), as the batch leaves things; `mutes` are the added ops.
 */
export function withInterlockMutes(
    ops: PatchOp[],
    config: { modules?: unknown; interlocks?: unknown },
): { ops: PatchOp[]; mutes: PatchOp[] } {
    const interlocks = (Array.isArray(config.interlocks) ? config.interlocks : []) as Groups;
    if (interlocks.length === 0) return { ops, mutes: [] };
    const modules = (config.modules ?? {}) as Modules;
    const now = new Map<string, boolean>();
    const isLive = (id: string) => now.get(id) ?? live(modules, id);
    const target = (op: PatchOp) => (op.op === 'replace' ? AUDIO_ENABLED.exec(op.path)?.[1] : undefined);
    // A member the batch sets itself is the batch's to decide (e.g. a manager's repaired config).
    const setByBatch = new Set(ops.map(target).filter((id): id is string => !!id));
    const out: PatchOp[] = [];
    const mutes: PatchOp[] = [];
    for (const op of ops) {
        const id = target(op);
        if (id && op.value === true) {
            for (const m of unmuteCascade(modules, interlocks, id, (other) => !setByBatch.has(other) && isLive(other))) {
                out.push(m);
                mutes.push(m);
                now.set(m.path.split('/')[2], false);
            }
        }
        if (id) now.set(id, op.value !== false);
        out.push(op);
    }
    return { ops: out, mutes };
}

/** Mutes that leave at most one member of each group live: the first live one in `members` order stays. */
export function interlockRepairs(config: { modules?: unknown; interlocks?: unknown }): PatchOp[] {
    const interlocks = (Array.isArray(config.interlocks) ? config.interlocks : []) as Groups;
    const modules = (config.modules ?? {}) as Modules;
    const out: PatchOp[] = [];
    for (const group of interlocks) {
        const hot = group.members.filter((id) => live(modules, id));
        out.push(...hot.slice(1).map(mute));
    }
    return out;
}

/**
 * Every member's `audioEnabled` as it stands, for each group holding one of
 * `moduleIds`: what a router reports after a change, so the last report wins
 * however messages cross on a slow link.
 */
export function groupStates(config: { modules?: unknown; interlocks?: unknown }, moduleIds: Iterable<string>): PatchOp[] {
    const interlocks = (Array.isArray(config.interlocks) ? config.interlocks : []) as Groups;
    const modules = (config.modules ?? {}) as Modules;
    const ids = new Set(moduleIds);
    const out: PatchOp[] = [];
    for (const group of interlocks) {
        if (!group.members.some((id) => ids.has(id))) continue;
        for (const id of group.members) {
            if (modules[id]?.settings) out.push({ op: 'replace', path: `/modules/${id}/settings/audioEnabled`, value: live(modules, id) });
        }
    }
    return out;
}

/** The modules whose `audioEnabled` these ops set. */
export const audioEnabledTargets = (ops: PatchOp[]): string[] =>
    ops.flatMap((op) => {
        const id = op.op === 'replace' ? AUDIO_ENABLED.exec(op.path)?.[1] : undefined;
        return id ? [id] : [];
    });


import type { PatchOp } from '@media-router/shared-types';
import type { PluginRegistry } from './plugins/PluginRegistry.js';

/**
 * Patch pre-processing rules.
 *
 * The manager rewrites and expands incoming patches before applying them to
 * SQLite. This file defines one rule per concern — pure functions matched
 * against each op. The first rule that matches owns the op.
 *
 * Each rule returns:
 *   - `processed`: ordered list of ops to apply (the rewritten original plus
 *     any cascades, in the order they should be applied).
 *   - `cascades`:  a subset of `processed` — the ops preprocessing *added* on
 *     top of the sender's original. The sender didn't apply these, so we echo
 *     them back. Rewrites of the original op are NOT cascades (the sender
 *     already applied their version and would double-apply a rewritten echo).
 *
 * Returning `null` means "not my op" — the dispatcher tries the next rule.
 * Returning `{ processed: [], cascades: [] }` means "handled, drop this op".
 */

/**
 * Read-only view of config state passed to each rule.
 *
 * `modules` is snapshotted once by the dispatcher before the loop begins, so
 * every rule computing a cascade from state (interlock mute, dynamic ports)
 * reads the state as it was when the patch arrived — not an intermediate
 * state that evolves as ops apply.
 *
 * `connections` and `interlocks` carry live *membership*: the dispatcher folds
 * each emitted op back in, so an id→index lookup lands where the element will
 * actually be at the point that op applies. Without this, a batch of two
 * id-based removes has the second index delete whatever slid into the freed
 * slot. Element *contents* are still pre-patch, so cascade decisions read the
 * arriving state; only order and membership move.
 *
 * Rules must therefore be pure reads over the context — the dispatcher calls
 * them more than once per op (see `dispatchRule`'s disjointness guard).
 */
export interface RuleContext {
    modules: Record<string, Record<string, unknown>>;
    interlocks: Array<{ id: string; members: string[] }>;
    connections: Array<Record<string, unknown>>;
    pluginRegistry: PluginRegistry;
    /**
     * The target engine's own reported config schemas (pluginId → configSchema),
     * or undefined when it hasn't reported. Preferred over the manager's local
     * schema when adding a module so it renders that engine's real capabilities
     * (issue #661).
     */
    engineSchemas?: Record<string, unknown>;
}

export interface RuleResult {
    processed: PatchOp[];
    cascades: PatchOp[];
}

export type Rule = (op: PatchOp, ctx: RuleContext) => RuleResult | null;

// --- Shared helpers ---------------------------------------------------------

/**
 * Interlock exclusive-mute rule expressed as ops: keep the first hot member
 * in `memberIds` live, mute the rest. `exceptModuleId` is excluded from the
 * mute output (used when the same patch is bringing it live — we don't want
 * to emit a redundant mute for a module that's about to be unmuted).
 */
function muteExceptFirstHot(
    modules: Record<string, Record<string, unknown>>,
    memberIds: string[],
    exceptModuleId?: string,
): PatchOp[] {
    const out: PatchOp[] = [];
    let keptHot = false;
    for (const id of memberIds) {
        const settings = modules[id]?.settings as Record<string, unknown> | undefined;
        const on = settings && settings.audioEnabled !== false;
        if (!on) continue;
        if (!keptHot) {
            keptHot = true;
            continue;
        }
        if (id === exceptModuleId) continue;
        out.push({ op: 'replace', path: `/modules/${id}/settings/audioEnabled`, value: false });
    }
    return out;
}

// --- Rules ------------------------------------------------------------------

/**
 * `/connections/<id>` → `/connections/<index>` so applyJsonPatch can walk the
 * array. The index comes from `ctx.connections`, which tracks removals/adds
 * already emitted by earlier ops in this batch — an id removed earlier in the
 * same batch is simply gone, and drops here rather than hitting its old slot.
 */
const rewriteConnectionIdPath: Rule = (op, ctx) => {
    const m = op.path.match(/^\/connections\/([^/]+)(\/.+)?$/);
    if (!m) return null;
    const [, key, rest = ''] = m;
    if (/^\d+$/.test(key) || key === '-') return null;

    const idx = ctx.connections.findIndex((c) => c.id === key);
    if (idx < 0) return { processed: [], cascades: [] }; // unknown id — drop
    return { processed: [{ ...op, path: `/connections/${idx}${rest}` }], cascades: [] };
};

/**
 * `/interlocks/<id>[/<field>]` → index-based. If the rewritten op is a
 * members-replace, also emit the exclusive-mute cascade so there can't be
 * two hot members after the change.
 */
const rewriteInterlockIdPath: Rule = (op, ctx) => {
    const m = op.path.match(/^\/interlocks\/([^/]+)(\/.+)?$/);
    if (!m) return null;
    const [, key, rest = ''] = m;
    if (/^\d+$/.test(key) || key === '-') return null;

    const idx = ctx.interlocks.findIndex((i) => i.id === key);
    if (idx < 0) return { processed: [], cascades: [] };

    const rewritten: PatchOp = { ...op, path: `/interlocks/${idx}${rest}` };
    const cascades: PatchOp[] =
        op.op === 'replace' && rest === '/members'
            ? muteExceptFirstHot(ctx.modules, (op.value as string[]) ?? [])
            : [];
    return { processed: [rewritten, ...cascades], cascades };
};

/**
 * `remove /modules/<id>` — also remove any connections touching the module
 * and prune it from every interlock it belongs to. Prevents orphans in
 * persisted state.
 */
const cascadeModuleDelete: Rule = (op, ctx) => {
    if (op.op !== 'remove' || !/^\/modules\/[^/]+$/.test(op.path)) return null;
    const moduleId = op.path.split('/')[2];

    const cascades: PatchOp[] = [];

    // Remove connections in reverse index order so earlier removals don't
    // shift indices. `ctx.connections` is the live membership view, so a
    // connection another op in this batch already removed isn't here at all.
    const touching = ctx.connections
        .map((c, i) => ({ idx: i, conn: c }))
        .filter((c) => c.conn.sourceModuleId === moduleId || c.conn.sinkModuleId === moduleId)
        .reverse();
    for (const { idx } of touching) {
        cascades.push({ op: 'remove', path: `/connections/${idx}` });
    }

    for (let i = 0; i < ctx.interlocks.length; i++) {
        const ilk = ctx.interlocks[i];
        if (ilk.members.includes(moduleId)) {
            cascades.push({
                op: 'replace',
                path: `/interlocks/${i}/members`,
                value: ilk.members.filter((m) => m !== moduleId),
            });
        }
    }

    return { processed: [...cascades, op], cascades };
};

/**
 * `replace /modules/<id>/settings/audioEnabled = true` — when the unmuted
 * module is an interlock member, mute every OTHER currently hot member FIRST
 * (the ordering guarantees there's never a one-frame window with two live).
 */
const cascadeInterlockUnmute: Rule = (op, ctx) => {
    if (op.op !== 'replace' || op.value !== true) return null;
    if (!/^\/modules\/[^/]+\/settings\/audioEnabled$/.test(op.path)) return null;

    const moduleId = op.path.split('/')[2];
    const ilk = ctx.interlocks.find((g) => g.members.includes(moduleId));
    if (!ilk) return { processed: [op], cascades: [] };

    const cascades: PatchOp[] = ilk.members
        .filter((id) => id !== moduleId)
        .filter((id) => {
            const settings = ctx.modules[id]?.settings as Record<string, unknown> | undefined;
            return settings && settings.audioEnabled !== false;
        })
        .map((id) => ({
            op: 'replace' as const,
            path: `/modules/${id}/settings/audioEnabled`,
            value: false,
        }));

    return { processed: [...cascades, op], cascades };
};

/** Index-path members replace (came from code, not a client) — same cascade as rewrite rule. */
const cascadeMembersIndexReplace: Rule = (op, ctx) => {
    if (op.op !== 'replace' || !/^\/interlocks\/\d+\/members$/.test(op.path)) return null;
    const cascades = muteExceptFirstHot(ctx.modules, (op.value as string[]) ?? []);
    return { processed: [op, ...cascades], cascades };
};

/** `add /interlocks/-` with pre-populated members — enforce "at most one hot" from the start. */
const cascadeInterlockCreate: Rule = (op, ctx) => {
    if (op.op !== 'add' || op.path !== '/interlocks/-') return null;
    if (!op.value || typeof op.value !== 'object') return null;
    const members = ((op.value as Record<string, unknown>).members as string[]) ?? [];
    const cascades = muteExceptFirstHot(ctx.modules, members);
    return { processed: [op, ...cascades], cascades };
};

/** `add /modules/<id>` — merge in defaults + ports + schema from the plugin manifest. */
const enrichModuleAdd: Rule = (op, ctx) => {
    if (op.op !== 'add' || !/^\/modules\/[^/]+$/.test(op.path) || !op.value) return null;

    const modValue = op.value as Record<string, unknown>;
    const pluginId = modValue.pluginId as string | undefined;
    const manifest = pluginId ? ctx.pluginRegistry.find(pluginId) : undefined;
    if (manifest) {
        // Prefer the engine's own probed schema (its real capabilities) over
        // the manager's local one; fall back when the engine hasn't reported.
        const configSchema =
            (pluginId ? ctx.engineSchemas?.[pluginId] : undefined) ?? manifest.configSchema ?? {};
        const schemaProps =
            (configSchema as { properties?: Record<string, Record<string, unknown>> })
                ?.properties ?? {};
        const defaults: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(schemaProps)) {
            if (schema.default !== undefined) defaults[key] = schema.default;
        }
        modValue.settings = {
            ...defaults,
            ...((modValue.settings as Record<string, unknown>) ?? {}),
        };
        modValue.ports = modValue.ports ?? manifest.ports ?? [];
        modValue.configSchema = configSchema;
    }

    return { processed: [{ ...op, value: modValue }], cascades: [] };
};

/** `replace .../settings/pairCount` on a dynamic-port plugin — regenerate the port list. */
const regenerateDynamicPorts: Rule = (op, ctx) => {
    if (op.op !== 'replace' || !/^\/modules\/[^/]+\/settings\/pairCount$/.test(op.path))
        return null;

    const moduleId = op.path.split('/')[2];
    const mod = ctx.modules[moduleId];
    if (!mod) return { processed: [op], cascades: [] };

    const manifest = ctx.pluginRegistry.find(mod.pluginId as string);
    if (!manifest || manifest.ports.length > 0) {
        // Not a dynamic-port plugin — just apply the setting, no port regen.
        return { processed: [op], cascades: [] };
    }

    const pairCount = op.value as number;
    const ports: unknown[] = [];
    const makePort = (dir: 'input' | 'output', i: number) => ({
        id: `${dir === 'input' ? 'in' : 'out'}-${i}`,
        direction: dir,
        streamType: 'audio/pcm',
        label: `${dir === 'input' ? 'In' : 'Out'} ${i + 1}`,
        maxConnections: -1,
    });
    for (let i = 0; i < pairCount; i++) ports.push(makePort('input', i));
    for (let i = 0; i < pairCount; i++) ports.push(makePort('output', i));

    const cascades: PatchOp[] = [
        { op: 'replace', path: `/modules/${moduleId}/ports`, value: ports },
    ];
    return { processed: [op, ...cascades], cascades };
};

/** `replace .../settings/channels` — drop channel-map entries that now point past the end. */
const pruneStaleChannelMaps: Rule = (op, ctx) => {
    if (op.op !== 'replace' || !/^\/modules\/[^/]+\/settings\/channels$/.test(op.path)) return null;

    const moduleId = op.path.split('/')[2];
    const newChannels = op.value as number;
    const cascades: PatchOp[] = [];

    for (let i = 0; i < ctx.connections.length; i++) {
        const conn = ctx.connections[i];
        const map = conn.channelMap;
        if (!Array.isArray(map) || map.length === 0) continue;
        if (conn.sourceModuleId !== moduleId && conn.sinkModuleId !== moduleId) continue;

        const filtered = map.filter((entry: { srcChannel: number; dstChannel: number }) => {
            if (conn.sourceModuleId === moduleId && entry.srcChannel >= newChannels) return false;
            if (conn.sinkModuleId === moduleId && entry.dstChannel >= newChannels) return false;
            return true;
        });
        if (filtered.length !== map.length) {
            cascades.push({
                op: 'replace',
                path: `/connections/${i}/channelMap`,
                value: filtered.length > 0 ? filtered : undefined,
            });
        }
    }

    return { processed: [op, ...cascades], cascades };
};

// --- Ordered rule table -----------------------------------------------------
//
// Order matters only where multiple rules *could* match the same op. The
// current set is disjoint: rewrite rules key off `/connections` and
// `/interlocks` prefixes with non-numeric non-`-` ids; cascade rules key off
// other specific paths. Add new rules carefully.

export const PATCH_RULES: Rule[] = [
    rewriteConnectionIdPath,
    rewriteInterlockIdPath,
    cascadeModuleDelete,
    cascadeInterlockUnmute,
    cascadeMembersIndexReplace,
    cascadeInterlockCreate,
    enrichModuleAdd,
    regenerateDynamicPorts,
    pruneStaleChannelMaps,
];

/**
 * Run `op` through the rule table. Returns the first rule's result, or a
 * passthrough (apply the op as-is, no cascades) if nothing matched.
 *
 * In non-production environments, asserts that at most one rule matches any
 * given op — catches accidental overlaps when someone adds a new rule with
 * a predicate that unintentionally competes with an existing one. In
 * production the check is skipped (first-wins behaviour is stable and
 * documented; the guard is purely a development trip-wire).
 */
export function dispatchRule(op: PatchOp, ctx: RuleContext): RuleResult {
    if (process.env.NODE_ENV !== 'production') {
        const matches = PATCH_RULES.filter((r) => r(op, ctx) !== null);
        if (matches.length > 1) {
            throw new Error(
                `dispatchRule: ${matches.length} rules matched op ${op.op} ${op.path}. ` +
                    `Rules must be disjoint — check match predicates.`,
            );
        }
    }
    for (const rule of PATCH_RULES) {
        const result = rule(op, ctx);
        if (result) return result;
    }
    return { processed: [op], cascades: [] };
}

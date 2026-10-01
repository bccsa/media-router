import { applyJsonPatch, audioEnabledTargets, groupStates, interlockRepairs, type PatchOp } from '@media-router/shared-types';

// Interlocks are kept on the router, for writes from any source (ADR-0028).

/**
 * After a batch (`withMutes`: the written ops with each unmute's mutes first)
 * is applied to `config`: any group still with several live keeps the first
 * in `members` (applied here). Returns every op, the ones made here, and the
 * manager's report — each touched group as it now stands, so the router's
 * last word wins however messages cross.
 */
export function settleInterlocks(
    config: Record<string, unknown>,
    written: PatchOp[],
    withMutes: PatchOp[],
    mutes: PatchOp[],
): { repairs: PatchOp[]; all: PatchOp[]; ours: PatchOp[]; report: PatchOp[] } {
    const repairs = interlockRepairs(config);
    applyJsonPatch(config, repairs);
    const all = [...withMutes, ...repairs];
    const regrouped = written.some((op) => op.path.startsWith('/interlocks'));
    const touched = [...audioEnabledTargets(all), ...(regrouped ? allMembers(config) : [])];
    return { repairs, all, ours: [...mutes, ...repairs], report: touched.length > 0 ? groupStates(config, touched) : [] };
}

function allMembers(config: Record<string, unknown>): string[] {
    const groups = Array.isArray(config.interlocks) ? (config.interlocks as Array<{ members?: unknown }>) : [];
    return groups.flatMap((g) => (Array.isArray(g.members) ? (g.members as string[]) : []));
}

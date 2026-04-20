import type { PatchOp } from '@media-router/shared-types';
import { validateInterlocksInvariants } from '@media-router/shared-types';

/**
 * Ensure at most one member of each interlock group has `audioEnabled=true`.
 * If multiple are hot (e.g. due to a pre-interlock saved config), keeps the
 * first member in the group's `members` array and returns patch ops that mute
 * the rest — order = priority.
 *
 * Also strips any member whose moduleId no longer exists in `config.modules`
 * (via `validateInterlocksInvariants`), and removes duplicate-membership
 * entries that may have crept in through buggy client writes.
 *
 * Assumes `config.interlocks` is already a proper array (ConfigStore.getProfile
 * normalizes on load, so callers don't need to).
 */
export function reconcileInterlocks(config: Record<string, unknown>): PatchOp[] {
    const interlocks = (config.interlocks ?? []) as Array<{ id: string; members: string[] }>;
    if (interlocks.length === 0) return [];

    const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
    const knownModuleIds = new Set(Object.keys(modules));
    const ops: PatchOp[] = [];

    // 1. Use the shared-types invariant check to identify orphan / duplicate
    // members. We rebuild each group's members from issues rather than trusting
    // filters in two places.
    const issues = validateInterlocksInvariants(interlocks, { knownModuleIds });
    const orphansByGroup = new Map<string, Set<string>>();
    for (const issue of issues) {
        if (issue.kind === 'unknown-member' || issue.kind === 'duplicate-member') {
            if (issue.moduleId) {
                const set = orphansByGroup.get(issue.interlockId) ?? new Set<string>();
                set.add(issue.moduleId);
                orphansByGroup.set(issue.interlockId, set);
            }
        }
    }

    for (const ilk of interlocks) {
        // Strip orphans + duplicates
        const toDrop = orphansByGroup.get(ilk.id);
        if (toDrop && toDrop.size > 0) {
            const seen = new Set<string>();
            const cleaned = ilk.members.filter((id) => {
                if (toDrop.has(id) || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            ilk.members = cleaned;
            ops.push({ op: 'replace', path: `/interlocks/${ilk.id}/members`, value: cleaned });
        }

        // 2. Enforce "at most one hot" — first member in array wins
        let hotSeen = false;
        for (const moduleId of ilk.members) {
            const mod = modules[moduleId];
            const settings = (mod?.settings ?? {}) as Record<string, unknown>;
            const isHot = settings.audioEnabled !== false;
            if (!isHot) continue;
            if (!hotSeen) {
                hotSeen = true;
                continue;
            }
            settings.audioEnabled = false;
            mod.settings = settings;
            ops.push({
                op: 'replace',
                path: `/modules/${moduleId}/settings/audioEnabled`,
                value: false,
            });
        }
    }

    return ops;
}

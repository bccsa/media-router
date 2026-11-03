import type {
    LiveInputBranch,
    ModuleServices,
    PipelineDescription,
    PluginModule,
} from './PluginModule.js';

/** The module's `getLiveInputBranch` for one edge, or null. */
function branchOf(
    plugin: PluginModule,
    sinkPortId: string,
    connectionId: string,
): LiveInputBranch | null {
    return plugin.getLiveInputBranch?.(sinkPortId, connectionId) ?? null;
}

/** A live input branch as launch text: its bin on request pad `sink_<pad>` of its aggregator.
 *  The 302M live arm renders its start-time branches with it, and the runner host the
 *  `liveInputs` it launches with (B-192). */
export function liveInputLaunchText(branch: LiveInputBranch, pad: number): string {
    return `( name=${branch.name} ${branch.description ?? ''} ) ! ${branch.element}.sink_${pad}`;
}

/** Bin names of the live input branches of every wired bus source (none without the hook). */
export function wiredLiveInputBranches(
    plugin: PluginModule,
    services: ModuleServices | null,
): string[] {
    const instanceId = services?.instanceId;
    if (!plugin.getLiveInputBranch || !instanceId || !services?.mediaRouter) return [];
    const names: string[] = [];
    for (const s of services.mediaRouter.getModuleBusSources(instanceId)) {
        const b = branchOf(plugin, s.sinkPortId, s.connectionId);
        if (b?.name) names.push(b.name);
    }
    return names;
}

/** Fill `desc.liveInputBranches` (bin names, one per wired bus source) so the
 *  runner can contain an error inside any of them. No hook, no field. */
export function annotateLiveInputBranches(
    plugin: PluginModule,
    services: ModuleServices | null,
    desc: PipelineDescription,
): void {
    const names = wiredLiveInputBranches(plugin, services);
    if (names.length) desc.liveInputBranches = names;
}

/** The producer behind a branch bin name, by display name, resolved through the connection
 *  records (they outlive the producer's bus port). */
export function describeLiveInputBranch(
    plugin: PluginModule,
    services: ModuleServices | null,
    name: string,
): string {
    const instanceId = services?.instanceId;
    const router = services?.mediaRouter;
    if (!plugin.getLiveInputBranch || !instanceId || !router) return name;
    for (const c of router.getModuleConnections(instanceId)) {
        if (c.sinkModuleId === instanceId && branchOf(plugin, c.sinkPortId, c.id)?.name === name) {
            return router.moduleName?.(c.sourceModuleId) ?? c.sourceModuleId;
        }
    }
    return name;
}

/** Why a module runs without a branch: the runner dropped it (its producer died), or it never
 *  ran in this pipeline (left out at launch, or a live add waiting for its producer). */
export type LostKind = 'lost' | 'not-running';

/** The live input branches a module runs without — dropped by the runner, or left out at
 *  launch while their producers were away (B-192) — one warning text naming all of them. */
export class LostInputs {
    private readonly lost = new Map<string, { who: string; kind: LostKind }>();

    /** Record a branch the module runs without; returns the warning text for the whole set. */
    lose(name: string, who: string, kind: LostKind = 'lost'): string {
        this.lost.set(name, { who, kind });
        return this.warning();
    }

    /** A branch is back; returns the remaining warning text, or null when none are left. */
    restore(name: string): string | null {
        this.lost.delete(name);
        return this.lost.size ? this.warning() : null;
    }

    has(name: string): boolean {
        return this.lost.has(name);
    }

    /** Forget every branch not in `names` (their connections are gone). */
    retain(names: ReadonlySet<string>): void {
        for (const name of [...this.lost.keys()]) if (!names.has(name)) this.lost.delete(name);
    }

    clear(): void {
        this.lost.clear();
    }

    get size(): number {
        return this.lost.size;
    }

    /** `Input from A lost — …`, `Input from B not running — …`, or `A lost, from B not running`. */
    warning(): string {
        const parts: string[] = [];
        for (const [kind, said] of [
            ['lost', 'lost'],
            ['not-running', 'not running'],
        ] as const) {
            const entries = [...this.lost.values()].filter((e) => e.kind === kind);
            const who = new Set(entries.map((e) => e.who));
            if (who.size) parts.push(`${[...who].join(', ')} ${said}`);
        }
        return `Input from ${parts.join(', from ')} — continuing without it`;
    }
}

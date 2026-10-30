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

/** `<producer> (<port>)` behind a branch bin name, resolved through the
 *  connection records (they outlive the producer's bus port). */
export function describeLiveInputBranch(
    plugin: PluginModule,
    services: ModuleServices | null,
    name: string,
): string {
    const instanceId = services?.instanceId;
    if (!plugin.getLiveInputBranch || !instanceId || !services?.mediaRouter) return name;
    for (const c of services.mediaRouter.getModuleConnections(instanceId)) {
        if (c.sinkModuleId === instanceId && branchOf(plugin, c.sinkPortId, c.id)?.name === name) {
            return `${c.sourceModuleId} (${c.sinkPortId})`;
        }
    }
    return name;
}

/** The live input branches a module runs without — dropped by the runner, or left out at
 *  launch while their producers were away (B-192) — one warning text naming all of them. */
export class LostInputs {
    private readonly lost = new Map<string, string>();

    /** Record a lost branch; returns the warning text for the whole set. */
    lose(name: string, who: string): string {
        this.lost.set(name, who);
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

    warning(): string {
        return `Input from ${[...this.lost.values()].join(', ')} lost — continuing without it`;
    }
}

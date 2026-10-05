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

/** Fill `desc.liveInputBranches` (bin names, one per wired bus source) so the
 *  runner can contain an error inside any of them. No hook, no field. */
export function annotateLiveInputBranches(
    plugin: PluginModule,
    services: ModuleServices | null,
    desc: PipelineDescription,
): void {
    const instanceId = services?.instanceId;
    if (!plugin.getLiveInputBranch || !instanceId || !services?.mediaRouter) return;
    const names: string[] = [];
    for (const s of services.mediaRouter.getModuleBusSources(instanceId)) {
        const b = branchOf(plugin, s.sinkPortId, s.connectionId);
        if (b?.name) names.push(b.name);
    }
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

/** The live input branches a module has lost (dropped by the runner) and
 *  not yet got back — one warning text naming all of them. */
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

    get size(): number {
        return this.lost.size;
    }

    warning(): string {
        return `Input from ${[...this.lost.values()].join(', ')} lost — continuing without it`;
    }
}

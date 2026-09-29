import {
    ROUTER_BRANCHES,
    ROUTER_INFO_META,
    appendRing,
    coerceArray,
    describeModule,
    getAt,
    keysOf,
    metaAt,
    overlayManifest,
    type DescribableModule,
    type ModuleMeta,
    type ModuleRuntimeState,
} from '@media-router/shared-types';
import type { TreeSource } from '@media-router/topic-tree';

/** What the router view reads from the engine. */
export interface RouterViewDeps {
    config(): Record<string, unknown> | null;
    manifest(pluginId: string): Record<string, unknown> | undefined;
    /** Effective config schema of a plugin on THIS host (issue #661). */
    schema(pluginId: string): unknown;
    state(instanceId: string): ModuleRuntimeState | undefined;
    info(): Record<string, unknown>;
}


type Obj = Record<string, unknown>;

/**
 * The router's own tree (ADR-0024), rooted at `/` — what the manager holds
 * under `/engines/<id>`, read straight from this engine.
 */
export class RouterView implements TreeSource {
    readonly logs: unknown[] = [];
    readonly devices: Record<string, unknown> = {};
    readonly vu: Record<string, number[]> = {};
    system: Obj | undefined;

    constructor(private readonly deps: RouterViewDeps) {}

    appendLogs(batch: unknown[]): void {
        appendRing(this.logs, batch);
    }

    get(path: readonly string[]): unknown {
        const [branch, ...rest] = path;
        if (branch === undefined) return Object.fromEntries(ROUTER_BRANCHES.map((b) => [b, this.get([b])]));
        if (branch === 'meta') return this.meta(rest);
        if (branch === 'modules' && rest.length > 0) return getAt(this.module(rest[0]), rest.slice(1));
        return getAt(this.branch(branch), rest);
    }

    keys(path: readonly string[]): string[] {
        return path.length === 0 ? [...ROUTER_BRANCHES] : keysOf(this.get(path));
    }

    branch(name: string): unknown {
        const config = this.deps.config();
        switch (name) {
            case 'info':
                return this.deps.info();
            case 'system':
                return this.system;
            case 'devices':
                return this.devices;
            case 'logs':
                return this.logs;
            case 'modules':
                return this.modules();
            case 'connections':
            case 'interlocks':
                return coerceArray(config?.[name]);
            default:
                return undefined;
        }
    }

    modules(): Obj {
        const stored = (this.deps.config()?.modules ?? {}) as Record<string, Obj>;
        return Object.fromEntries(Object.keys(stored).map((id) => [id, this.module(id)]));
    }

    /** One module: stored config + manifest + this host's schema + runtime + VU. */
    module(instanceId: string): Obj | undefined {
        const stored = ((this.deps.config()?.modules ?? {}) as Record<string, Obj>)[instanceId];
        if (!stored) return undefined;
        const pluginId = stored.pluginId as string;
        const manifest = this.deps.manifest(pluginId);
        const mod: Obj = { ...stored, instanceId };
        // The same overlay the manager applies (PluginRegistry.overlayManifest).
        if (manifest) overlayManifest(mod, manifest, this.deps.schema(pluginId));
        const state = this.deps.state(instanceId);
        if (state) {
            const { vuData: _vu, ...lean } = state;
            Object.assign(mod, lean);
        }
        if (this.vu[instanceId]) mod.vu = this.vu[instanceId];
        return mod;
    }

    /** `/meta` (ADR-0024): what this router's values are and which take writes; not part of `/`. */
    meta(rest: readonly string[]): unknown {
        return metaAt(rest, ROUTER_INFO_META, () => this.moduleIds(), (m) => this.moduleMeta(m));
    }

    moduleIds(): string[] {
        return Object.keys((this.deps.config()?.modules ?? {}) as Obj);
    }

    /** A router takes `enabled` and settings writes only. */
    moduleMeta(instanceId: string): ModuleMeta | undefined {
        const mod = this.module(instanceId);
        return mod ? describeModule(mod as DescribableModule, ['enabled']) : undefined;
    }
}

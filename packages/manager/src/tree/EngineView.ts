import {
    ENGINE_BRANCHES,
    coerceArray,
    dashboardsOf,
    describeModule,
    dropUndefined,
    type DescribableModule,
    type ModuleMeta,
} from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { RuntimeCache } from './RuntimeCache.js';


export interface EngineViewDeps {
    configStore: ConfigStore;
    runtime: RuntimeCache;
    pluginRegistry: PluginRegistry;
    engineManager: EngineConnectionManager;
}

type Obj = Record<string, unknown>;


/**
 * Builds the tree branches of one engine on demand: its stored profile, the
 * plugin manifest overlay and what the engine reports at runtime, merged.
 */
export class EngineView {
    constructor(private readonly deps: EngineViewDeps) {}

    ids(): string[] {
        return this.deps.configStore.getAllEngines().map((e) => e.engine_id as string);
    }

    exists(engineId: string): boolean {
        return !!this.deps.configStore.getEngine(engineId);
    }

    /** The active profile's stored config. */
    profileConfig(engineId: string): Obj | undefined {
        const engine = this.deps.configStore.getEngine(engineId);
        if (!engine?.active_profile) return undefined;
        return this.deps.configStore.getProfile(engineId, engine.active_profile as string);
    }

    info(engineId: string): Obj | undefined {
        const { configStore, runtime, engineManager } = this.deps;
        const engine = configStore.getEngine(engineId);
        if (!engine) return undefined;
        const profile = this.profileConfig(engineId);
        const data = (topic: string) => runtime.getData(engineId, topic);
        return dropUndefined({
            name: engine.display_name,
            online: engineManager.isEngineOnline(engineId),
            running: profile?.running === true,
            activeProfile: engine.active_profile ?? null,
            groupId: engine.group_id ?? 'ungrouped',
            sortOrder: engine.sort_order ?? 0,
            ip: data('ip'),
            ips: data('ips'),
            hostname: data('hostname'),
            buildNumber: data('buildNumber'),
            features: data('features'),
            managerPaths: data('managerPaths'),
            paths: engineManager.enginePaths(engineId),
            moduleCount: Object.keys((profile?.modules ?? {}) as Obj).length,
            connectionCount: coerceArray(profile?.connections).length,
        });
    }

    /** One module: stored config + manifest overlay + runtime state + VU. */
    mergeModule(engineId: string, moduleId: string, stored: Obj): Obj {
        const { runtime, pluginRegistry } = this.deps;
        const mod: Obj = { ...stored };
        pluginRegistry.enrichModule(moduleId, mod, runtime.getPluginSchemas(engineId));
        const state = runtime.getStates(engineId)[moduleId];
        if (state) Object.assign(mod, state);
        const vu = runtime.getVu(engineId)[moduleId];
        if (vu) mod.vu = vu;
        return mod;
    }

    modules(engineId: string): Obj {
        const stored = (this.profileConfig(engineId)?.modules ?? {}) as Record<string, Obj>;
        const out: Obj = {};
        for (const [id, mod] of Object.entries(stored)) out[id] = this.mergeModule(engineId, id, mod);
        return out;
    }

    module(engineId: string, moduleId: string): Obj | undefined {
        const stored = ((this.profileConfig(engineId)?.modules ?? {}) as Record<string, Obj>)[moduleId];
        return stored ? this.mergeModule(engineId, moduleId, stored) : undefined;
    }

    moduleIds(engineId: string): string[] {
        return Object.keys((this.profileConfig(engineId)?.modules ?? {}) as Obj);
    }

    /** A module's `/meta` node (ADR-0024). */
    moduleMeta(engineId: string, moduleId: string): ModuleMeta | undefined {
        const mod = this.module(engineId, moduleId);
        return mod ? describeModule(mod as DescribableModule) : undefined;
    }

    profiles(engineId: string): Obj {
        const active = this.deps.configStore.getEngine(engineId)?.active_profile;
        const out: Obj = {};
        for (const { profile_name } of this.deps.configStore.getProfiles(engineId)) {
            out[profile_name] = { name: profile_name, active: profile_name === active };
        }
        return out;
    }

    branch(engineId: string, name: string): unknown {
        const { runtime } = this.deps;
        switch (name) {
            case 'info':
                return this.info(engineId);
            case 'system':
                return runtime.getData(engineId, 'system');
            case 'devices':
                return runtime.getDevices(engineId);
            case 'logs':
                return runtime.getLogs(engineId);
            case 'modules':
                return this.modules(engineId);
            case 'connections':
                return coerceArray(this.profileConfig(engineId)?.connections);
            case 'interlocks':
                return coerceArray(this.profileConfig(engineId)?.interlocks);
            case 'profiles':
                return this.profiles(engineId);
            case 'dashboards':
                return dashboardsOf(this.profileConfig(engineId));
            default:
                return undefined;
        }
    }

    engine(engineId: string): Obj | undefined {
        if (!this.exists(engineId)) return undefined;
        const out: Obj = {};
        for (const name of ENGINE_BRANCHES) {
            const value = this.branch(engineId, name);
            if (value !== undefined) out[name] = value;
        }
        return out;
    }
}

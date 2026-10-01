import { ENGINE_BRANCHES, ENGINE_INFO_META, getAt, keysOf, metaAt } from '@media-router/shared-types';
import type { TreeSource } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { EngineView } from './EngineView.js';

const ROOTS = ['engines', 'groups', 'settings', 'plugins', 'dashboards'];

export interface ManagerTreeDeps {
    view: EngineView;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
}

/** The manager's tree (ADR-0024), read on demand from the config store and caches. `/meta` sits beside it. */
export class ManagerTree implements TreeSource {
    /** Button runs (ADR-0027, set by ManagerScripts); `/runs` sits beside the roots, like `/meta`. */
    runs: () => Record<string, unknown> = () => ({});

    constructor(private readonly deps: ManagerTreeDeps) {}

    get(path: readonly string[]): unknown {
        const [root, ...rest] = path;
        if (root === undefined) {
            return Object.fromEntries(ROOTS.map((r) => [r, this.get([r])]));
        }
        switch (root) {
            case 'engines':
                return this.engines(rest);
            case 'groups':
                return getAt(this.groups(), rest);
            case 'settings':
                return getAt({ dgramListeners: this.deps.engineManager.dgramListeners }, rest);
            case 'plugins':
                return getAt(this.plugins(), rest);
            case 'dashboards':
                return getAt(this.deps.configStore.getDashboards(), rest);
            case 'meta':
                return this.meta(rest);
            case 'runs':
                return getAt(this.runs(), rest);
            default:
                return undefined;
        }
    }

    keys(path: readonly string[]): string[] {
        if (path.length === 0) return [...ROOTS];
        if (path[0] === 'engines' && path.length === 1) return this.deps.view.ids();
        if (path[0] === 'meta' && path.length === 2 && path[1] === 'engines') return this.deps.view.ids();
        if (path[0] === 'engines' && path.length === 2) {
            return this.deps.view.exists(path[1]) ? [...ENGINE_BRANCHES] : [];
        }
        return keysOf(this.get(path));
    }

    groups(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const row of this.deps.configStore.getAllGroups()) out[row.id as string] = row;
        return out;
    }

    private engines(rest: readonly string[]): unknown {
        const { view } = this.deps;
        const [engineId, branch, ...deeper] = rest;
        if (engineId === undefined) {
            return Object.fromEntries(view.ids().map((id) => [id, view.engine(id)]));
        }
        if (!view.exists(engineId)) return undefined;
        if (branch === undefined) return view.engine(engineId);
        // A single module is built on its own — cheaper than every module.
        if (branch === 'modules' && deeper.length > 0) {
            return getAt(view.module(engineId, deeper[0]), deeper.slice(1));
        }
        return getAt(view.branch(engineId, branch), deeper);
    }

    /** Descriptors, mirroring `/engines` (ADR-0024); not part of `/` — subscribe by name. */
    private meta(rest: readonly string[]): unknown {
        const { view } = this.deps;
        const [root, engineId, ...below] = rest;
        const one = (id: string, path: readonly string[]) =>
            view.exists(id)
                ? metaAt(path, ENGINE_INFO_META, () => view.moduleIds(id), (m) => view.moduleMeta(id, m))
                : undefined;
        const all = () => Object.fromEntries(view.ids().map((id) => [id, one(id, [])]));
        if (root === undefined) return { engines: all() };
        if (root !== 'engines') return undefined;
        return engineId === undefined ? all() : one(engineId, below);
    }

    private plugins(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const manifest of this.deps.pluginRegistry.getAll()) out[manifest.pluginId] = manifest;
        return out;
    }
}

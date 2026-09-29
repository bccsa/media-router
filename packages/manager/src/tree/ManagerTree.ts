import { ENGINE_BRANCHES, getAt, keysOf } from '@media-router/shared-types';
import type { TreeSource } from '@media-router/topic-tree';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { EngineView } from './EngineView.js';

const ROOTS = ['engines', 'groups', 'settings', 'plugins'];

export interface ManagerTreeDeps {
    view: EngineView;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
}

/** The manager's tree (ADR-0024), read on demand from the config store and caches. */
export class ManagerTree implements TreeSource {
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
            default:
                return undefined;
        }
    }

    keys(path: readonly string[]): string[] {
        if (path.length === 0) return [...ROOTS];
        if (path[0] === 'engines' && path.length === 1) return this.deps.view.ids();
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

    private plugins(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const manifest of this.deps.pluginRegistry.getAll()) out[manifest.pluginId] = manifest;
        return out;
    }
}

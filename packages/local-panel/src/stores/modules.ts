import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getStripComponent } from '../composables/usePluginStripComponent';

/** Module state as received from the engine's LcpServer. */
export interface LcpModuleState {
    instanceId: string;
    pluginId: string;
    displayName: string;
    health: string;
    running: boolean;
    ready: boolean;
    error?: string;
    settings: Record<string, unknown>;
    lcpType?: string;
}

/**
 * Module store for the Local Control Panel.
 * Tracks module states received from the engine, filters by lcpVisible,
 * sorts by lcpSortOrder.
 */
export const useModuleStore = defineStore('modules', () => {
    const modules = ref<Record<string, LcpModuleState>>({});
    const engineRunning = ref(false);
    const engineIp = ref('');
    const engineIps = ref<string[]>([]);
    const engineHostname = ref('');
    const buildNumber = ref('');

    /**
     * Modules visible on the LCP, sorted by lcpSortOrder. A module is LCP-
     * visible if either:
     *   - the manifest declares an `lcpType` (the classic mixer-strip flag), or
     *   - the plugin ships its own `ui/LcpStrip.vue` component.
     * Either way, `lcpVisible` in settings can hide individual instances.
     */
    const visibleModules = computed(() => {
        return Object.values(modules.value)
            .filter((m) => {
                const eligible = !!m.lcpType || !!getStripComponent(m.pluginId);
                if (!eligible) return false;
                const visible = m.settings?.lcpVisible;
                return visible !== false; // default true
            })
            .sort((a, b) => {
                const orderA = (a.settings?.lcpSortOrder as number) ?? 0;
                const orderB = (b.settings?.lcpSortOrder as number) ?? 0;
                return orderA - orderB;
            });
    });

    /** Set all module states (initial sync). */
    function setAll(states: Record<string, unknown>) {
        const result: Record<string, LcpModuleState> = {};
        for (const [id, state] of Object.entries(states)) {
            result[id] = normalizeState(id, state);
        }
        modules.value = result;
    }

    /** Update a single module state (runtime fields only — preserves existing config). */
    function updateState(instanceId: string, state: unknown) {
        const existing = modules.value[instanceId];
        const s = state as Record<string, unknown>;
        // Only update runtime fields that are actually present in the update
        const updates: Partial<LcpModuleState> = {};
        if ('health' in s) updates.health = s.health as string;
        if ('running' in s) updates.running = s.running as boolean;
        if ('ready' in s) updates.ready = s.ready as boolean;
        if ('error' in s) updates.error = s.error as string | undefined;
        if ('displayName' in s) updates.displayName = s.displayName as string;
        if ('settings' in s) updates.settings = s.settings as Record<string, unknown>;
        if ('lcpType' in s) updates.lcpType = s.lcpType as string;

        if (existing) {
            modules.value = { ...modules.value, [instanceId]: { ...existing, ...updates } };
        } else {
            modules.value = { ...modules.value, [instanceId]: normalizeState(instanceId, state) };
        }
    }

    /** Apply a config update (JSON Patch or full replace). */
    function applyConfig(config: Record<string, unknown>) {
        const mods = (config.modules ?? config) as Record<string, Record<string, unknown>>;
        for (const [id, modConfig] of Object.entries(mods)) {
            if (modules.value[id]) {
                modules.value[id] = {
                    ...modules.value[id],
                    displayName: (modConfig.displayName as string) ?? modules.value[id].displayName,
                    settings:
                        (modConfig.settings as Record<string, unknown>) ??
                        modules.value[id].settings,
                    lcpType: (modConfig.lcpType as string) ?? modules.value[id].lcpType,
                };
            } else {
                modules.value[id] = normalizeState(id, modConfig);
            }
        }
        // Remove deleted modules
        for (const id of Object.keys(modules.value)) {
            if (!mods[id]) {
                delete modules.value[id];
            }
        }
        // Trigger reactivity
        modules.value = { ...modules.value };
    }

    /** Remove a module. */
    function remove(instanceId: string) {
        delete modules.value[instanceId];
        modules.value = { ...modules.value };
    }

    /** Apply JSON Patch operations (incremental config updates from engine). */
    function applyPatch(patch: Array<{ op: string; path: string; value?: unknown }>) {
        let changed = false;
        for (const op of patch) {
            if (op.path === '/') {
                applyConfig(op.value as Record<string, unknown>);
                return;
            }
            const parts = op.path.split('/').filter(Boolean);
            if (parts[0] !== 'modules' || !parts[1]) continue;

            const moduleId = parts[1];
            const mod = modules.value[moduleId];

            // /modules/{id}/settings/{key}
            if (mod && parts[2] === 'settings' && parts[3]) {
                mod.settings = { ...mod.settings, [parts[3]]: op.value };
                changed = true;
            }
            // /modules/{id}/{field} (displayName, enabled, position, ports, etc.)
            else if (mod && parts[2] && !parts[3]) {
                (mod as any)[parts[2]] = op.value;
                changed = true;
            }
            // /modules/{id} (add/remove entire module)
            else if (!parts[2]) {
                if (op.op === 'add' && op.value) {
                    modules.value[moduleId] = normalizeState(moduleId, op.value);
                    changed = true;
                } else if (op.op === 'remove') {
                    delete modules.value[moduleId];
                    changed = true;
                }
            }
        }
        if (changed) {
            modules.value = { ...modules.value };
        }
    }

    function normalizeState(instanceId: string, raw: unknown): LcpModuleState {
        const s = raw as Record<string, unknown>;
        return {
            instanceId,
            pluginId: (s.pluginId as string) ?? '',
            displayName: (s.displayName as string) ?? instanceId,
            health: (s.health as string) ?? 'stopped',
            running: (s.running as boolean) ?? false,
            ready: (s.ready as boolean) ?? false,
            error: s.error as string | undefined,
            settings: (s.settings as Record<string, unknown>) ?? {},
            lcpType: (s.lcpType as string) ?? undefined,
        };
    }

    /** Update a single setting on a module (optimistic local update). */
    function updateSetting(instanceId: string, key: string, value: unknown) {
        const mod = modules.value[instanceId];
        if (!mod) return;
        mod.settings = { ...mod.settings, [key]: value };
        modules.value = { ...modules.value };
    }

    return {
        modules,
        engineRunning,
        engineIp,
        engineIps,
        engineHostname,
        buildNumber,
        visibleModules,
        setAll,
        updateState,
        applyConfig,
        applyPatch,
        updateSetting,
        remove,
    };
});

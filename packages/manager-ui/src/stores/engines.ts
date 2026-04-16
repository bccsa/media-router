import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

// --- Types ---

export interface PortInfo {
    id: string;
    direction: 'input' | 'output';
    streamType: string;
    label: string;
    /** Max connections: -1 = unlimited, 0 = disabled, 1+ = fixed limit. */
    maxConnections?: number;
    /** Whether user can change maxConnections at runtime. */
    userConfigurable?: boolean;
}

export interface StatusSectionDef {
    id: string;
    label: string;
    fields: Array<{ key: string; label: string; unit?: string; format?: string }>;
}

export interface ModuleState {
    instanceId: string;
    pluginId: string;
    displayName: string;
    running: boolean;
    enabled: boolean;
    health: string;
    pendingRestart: boolean;
    color?: string;
    icon?: string;
    vuData?: number[];
    error?: string;
    position?: { x: number; y: number };
    settings: Record<string, unknown>;
    ports?: PortInfo[];
    configSchema?: Record<string, unknown>;
    statusSections?: StatusSectionDef[];
    statusData?: Record<string, Record<string, string | number | boolean>>;
    dynamicStatusSections?: StatusSectionDef[];
    badges?: Array<{ id: string; icon?: string; text: string; color?: string }>;
    faceWidgets?: Array<Record<string, unknown>>;
    focused?: boolean;
}

/** Mirrors @media-router/shared-types ChannelMapEntry (browser can't import Node packages). */
export interface ChannelMapEntry {
    srcChannel: number;
    dstChannel: number;
    gain?: number;
}

export interface ConnectionState {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    label?: string;
    channelMap?: ChannelMapEntry[];
}

export interface SystemStats {
    cpu: number;    // CPU usage %
    mem: number;    // Memory usage %
    temp: number | null;  // CPU temperature °C
    processCount?: number;  // Spawned child processes
}

export interface EngineState {
    engineId: string;
    name: string;
    online: boolean;
    running: boolean;
    activeProfile: string | null;
    modules: Record<string, ModuleState>;
    connections: ConnectionState[];
    system?: SystemStats;
    ip?: string;
    ips?: string[];
    hostname?: string;
    buildNumber?: string;
}

// --- Store ---

export const useEngineStore = defineStore('engines', () => {
    const engines = ref<Map<string, EngineState>>(new Map());

    const engineList = computed(() => Array.from(engines.value.values()));

    function getEngine(engineId: string): EngineState | undefined {
        return engines.value.get(engineId);
    }

    /**
     * Add an engine from server data. Normalises modules to include instanceId.
     */
    function addEngine(data: Record<string, unknown>) {
        const modules: Record<string, ModuleState> = {};
        const rawModules = (data.modules ?? {}) as Record<string, Record<string, unknown>>;
        for (const [id, mod] of Object.entries(rawModules)) {
            modules[id] = {
                instanceId: id,
                pluginId: (mod.pluginId as string) ?? '',
                displayName: (mod.displayName as string) ?? id,
                running: (mod.running as boolean) ?? false,
                enabled: (mod.enabled as boolean) ?? true,
                health: (mod.health as string) ?? 'stopped',
                pendingRestart: (mod.pendingRestart as boolean) ?? false,
                position: mod.position as { x: number; y: number } | undefined,
                settings: (mod.settings ?? {}) as Record<string, unknown>,
                ports: mod.ports as PortInfo[] | undefined,
                configSchema: mod.configSchema as Record<string, unknown> | undefined,
                color: mod.color as string | undefined,
                icon: mod.icon as string | undefined,
                statusSections: mod.statusSections as StatusSectionDef[] | undefined,
                statusData: mod.statusData as Record<string, Record<string, string | number | boolean>> | undefined,
                focused: (mod.focused as boolean) ?? false,
            };
        }

        engines.value.set(data.engine_id as string, {
            engineId: data.engine_id as string,
            name: (data.display_name as string) ?? '',
            online: (data.online as boolean) ?? false,
            running: (data.running as boolean) ?? false,
            activeProfile: (data.active_profile as string) ?? null,
            modules,
            connections: (data.connections ?? []) as ConnectionState[],
            ip: data.ip as string | undefined,
            ips: data.ips as string[] | undefined,
            hostname: data.hostname as string | undefined,
            buildNumber: data.buildNumber as string | undefined,
        });
    }

    /** Set full config (modules + connections) for an engine — used by lazy loading. */
    function setEngineConfig(engineId: string, rawModules: Record<string, unknown>, rawConnections: unknown[]) {
        const engine = engines.value.get(engineId);
        if (!engine) return;

        const modules: Record<string, ModuleState> = {};
        for (const [id, mod] of Object.entries(rawModules as Record<string, Record<string, unknown>>)) {
            modules[id] = {
                instanceId: id,
                pluginId: (mod.pluginId as string) ?? '',
                displayName: (mod.displayName as string) ?? id,
                running: (mod.running as boolean) ?? false,
                enabled: (mod.enabled as boolean) ?? true,
                health: (mod.health as string) ?? 'stopped',
                pendingRestart: (mod.pendingRestart as boolean) ?? false,
                position: mod.position as { x: number; y: number } | undefined,
                settings: (mod.settings ?? {}) as Record<string, unknown>,
                ports: mod.ports as PortInfo[] | undefined,
                configSchema: mod.configSchema as Record<string, unknown> | undefined,
                color: mod.color as string | undefined,
                icon: mod.icon as string | undefined,
                statusSections: mod.statusSections as StatusSectionDef[] | undefined,
                statusData: mod.statusData as Record<string, Record<string, string | number | boolean>> | undefined,
                focused: (mod.focused as boolean) ?? false,
            };
        }

        engine.modules = modules;
        engine.connections = rawConnections as ConnectionState[];
        engines.value = new Map(engines.value);
    }

    /**
     * Apply JSON Patch (RFC 6902) operations to an engine's state.
     */
    function applyEnginePatch(engineId: string, patch: unknown[]) {
        const engine = engines.value.get(engineId);
        if (!engine) return;

        const updated: EngineState = {
            ...engine,
            modules: { ...engine.modules },
            connections: [...engine.connections],
        };

        for (const op of patch as Array<{ op: string; path: string; value?: unknown }>) {
            applyOp(updated as unknown as Record<string, unknown>, op);
        }

        engines.value.set(engineId, updated);
        engines.value = new Map(engines.value);
    }

    /**
     * Apply a single JSON Patch op to a nested object.
     * Handles: objects, arrays (by numeric index or by .id lookup), append via '-'.
     */
    function applyOp(obj: Record<string, unknown>, op: { op: string; path: string; value?: unknown }) {
        const parts = op.path.split('/').filter(Boolean);
        const last = parts.pop();
        if (!last) return;

        // Walk to the parent of the target field
        let target: any = obj;
        for (const part of parts) {
            target = Array.isArray(target) ? target[arrIdx(target, part)] : target?.[part];
            if (target == null) return;
        }

        const idx = Array.isArray(target) ? arrIdx(target, last) : -1;

        switch (op.op) {
            case 'add':
            case 'replace':
                if (last === '-' && Array.isArray(target)) target.push(op.value);
                else if (Array.isArray(target) && idx >= 0) target[idx] = op.value;
                else target[last] = op.value;
                break;
            case 'remove':
                if (Array.isArray(target) && idx >= 0) target.splice(idx, 1);
                else delete target[last];
                break;
        }
    }

    /** Resolve array key: numeric index or .id lookup. */
    function arrIdx(arr: unknown[], key: string): number {
        const n = parseInt(key, 10);
        if (!isNaN(n)) return n;
        return arr.findIndex((item) => (item as any)?.id === key);
    }

    function setOnline(engineId: string, online: boolean) {
        const engine = engines.value.get(engineId);
        if (!engine || engine.online === online) return;
        // Replace with a new object so Vue's computed caching detects the change
        engines.value.set(engineId, { ...engine, online });
        engines.value = new Map(engines.value);
    }

    /** Clear runtime data when engine goes offline (stats, module health, badges). */
    function clearEngineRuntime(engineId: string) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        engine.running = false;
        engine.system = undefined;
        for (const mod of Object.values(engine.modules)) {
            mod.running = false;
            mod.health = 'stopped';
            mod.error = undefined;
            mod.statusData = undefined;
            mod.badges = undefined;
        }
        engines.value = new Map(engines.value);
    }

    function setRunning(engineId: string, running: boolean) {
        const engine = engines.value.get(engineId);
        if (!engine || engine.running === running) return;
        engines.value.set(engineId, { ...engine, running });
        engines.value = new Map(engines.value);
    }

    function updateEngineInfo(data: Record<string, unknown>) {
        const engine = engines.value.get(data.engine_id as string);
        if (engine) {
            engine.name = (data.display_name as string) ?? engine.name;
            engine.activeProfile = (data.active_profile as string) ?? engine.activeProfile;
            engine.online = (data.online as boolean) ?? engine.online;
            engines.value = new Map(engines.value);
        }
    }

    function removeEngine(engineId: string) {
        engines.value.delete(engineId);
        engines.value = new Map(engines.value);
    }

    /** Remove a connection from an engine's local state. */
    function removeConnection(engineId: string, connectionId: string) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        engine.connections = engine.connections.filter((c) => c.id !== connectionId);
        engines.value = new Map(engines.value);
    }

    function setSystemStats(engineId: string, stats: SystemStats) {
        const engine = engines.value.get(engineId);
        if (engine) {
            engine.system = stats;
            engines.value = new Map(engines.value);
        }
    }

    function setEngineInfo(engineId: string, info: { ip?: string; ips?: string[]; hostname?: string; buildNumber?: string }) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        let changed = false;
        if (info.ip && engine.ip !== info.ip) { engine.ip = info.ip; changed = true; }
        if (info.ips && JSON.stringify(info.ips) !== JSON.stringify(engine.ips)) { engine.ips = info.ips; changed = true; }
        if (info.hostname && engine.hostname !== info.hostname) { engine.hostname = info.hostname; changed = true; }
        if (info.buildNumber && engine.buildNumber !== info.buildNumber) { engine.buildNumber = info.buildNumber; changed = true; }
        if (changed) engines.value = new Map(engines.value);
    }

    /** Force Vue reactivity trigger for an engine (after in-place module mutations). */
    function touchEngine(engineId: string) {
        engines.value = new Map(engines.value);
    }

    return {
        engines,
        engineList,
        getEngine,
        addEngine,
        setEngineConfig,
        applyEnginePatch,
        setOnline,
        clearEngineRuntime,
        setRunning,
        updateEngineInfo,
        removeEngine,
        removeConnection,
        setSystemStats,
        setEngineInfo,
        touchEngine,
    };
});

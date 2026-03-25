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
            hostname: data.hostname as string | undefined,
            buildNumber: data.buildNumber as string | undefined,
        });
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
            applyPatchOperation(updated as unknown as Record<string, unknown>, op);
        }

        engines.value.set(engineId, updated);
        engines.value = new Map(engines.value);
    }

    function applyPatchOperation(
        obj: Record<string, unknown>,
        op: { op: string; path: string; value?: unknown },
    ) {
        const parts = op.path.split('/').filter(Boolean);
        const last = parts.pop();
        if (!last) return;

        let target: Record<string, unknown> = obj;
        for (const part of parts) {
            if (target[part] === undefined || target[part] === null) {
                if (op.op === 'add') {
                    target[part] = {};
                } else {
                    return;
                }
            }
            target = target[part] as Record<string, unknown>;
        }

        switch (op.op) {
            case 'add':
            case 'replace':
                // Handle JSON Patch `-` (append to array)
                if (last === '-' && Array.isArray(target)) {
                    (target as unknown[]).push(op.value);
                } else {
                    target[last] = op.value;
                }
                break;
            case 'remove':
                if (Array.isArray(target)) {
                    const idx = parseInt(last, 10);
                    if (!isNaN(idx)) target.splice(idx, 1);
                } else {
                    delete target[last];
                }
                break;
        }
    }

    function setOnline(engineId: string, online: boolean) {
        const engine = engines.value.get(engineId);
        if (engine) {
            engine.online = online;
            engines.value = new Map(engines.value);
        }
    }

    function setRunning(engineId: string, running: boolean) {
        const engine = engines.value.get(engineId);
        if (engine) {
            engine.running = running;
            engines.value = new Map(engines.value);
        }
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

    function setEngineInfo(engineId: string, info: { ip?: string; hostname?: string; buildNumber?: string }) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        let changed = false;
        if (info.ip && engine.ip !== info.ip) { engine.ip = info.ip; changed = true; }
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
        applyEnginePatch,
        setOnline,
        setRunning,
        updateEngineInfo,
        removeEngine,
        removeConnection,
        setSystemStats,
        setEngineInfo,
        touchEngine,
    };
});

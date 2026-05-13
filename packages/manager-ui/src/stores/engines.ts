import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
// shared-types is built as CJS (because the engine/manager runtime is CJS).
// Vite's CJS↔ESM interop only synthesizes a default export for the module,
// so named bindings like `import { applyJsonPatch }` fail with
// "X is not exported by …/dist/index.js". Use a namespace import — that
// gives us `esModuleInterop`-style access to the underlying CJS exports.
import * as shared from '@media-router/shared-types';
import type { ModuleSize, PatchOp, ResizableBounds } from '@media-router/shared-types';
const { applyJsonPatch, coerceArray } = shared;

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
    /** Runtime list of config keys the plugin currently accepts live —
     *  plugins may narrow this based on current config. Falls back to schema
     *  `x-live`/`x-liveUpdatable` if absent. */
    liveUpdatableParams?: string[];
    color?: string;
    icon?: string;
    vuData?: number[];
    error?: string;
    position?: { x: number; y: number };
    /** Per-instance size on the routing view (only set for resizable plugins). */
    size?: ModuleSize;
    settings: Record<string, unknown>;
    ports?: PortInfo[];
    configSchema?: Record<string, unknown>;
    statusSections?: StatusSectionDef[];
    statusData?: Record<string, Record<string, string | number | boolean>>;
    dynamicStatusSections?: StatusSectionDef[];
    badges?: Array<{ id: string; icon?: string; text: string; color?: string }>;
    faceWidgets?: Array<Record<string, unknown>>;
    focused?: boolean;
    /** Plugin manifest opts into interlock (exclusive-mute) groups. */
    interlock?: boolean;
    /**
     * Plugin opted into user-resizable cards. `false`/undefined = fixed size.
     * Object form carries min/max bounds the plugin set.
     */
    resizable?: boolean | ResizableBounds;
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
    cpu: number; // CPU usage %
    mem: number; // Memory usage %
    temp: number | null; // CPU temperature °C
    processCount?: number; // Spawned child processes
}

/** Exclusive-mute group: only one member may have settings.audioEnabled=true. */
export interface InterlockState {
    id: string;
    name: string;
    members: string[];
    color?: string;
}

export interface EngineState {
    engineId: string;
    name: string;
    online: boolean;
    running: boolean;
    activeProfile: string | null;
    modules: Record<string, ModuleState>;
    connections: ConnectionState[];
    interlocks: InterlockState[];
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
     * Turn raw server-shape module data into a `ModuleState`. Single point of
     * truth for every per-module field — used by both `addEngine` (initial
     * sync) and `setEngineConfig` (lazy profile load). Adding a new field
     * means one edit here, not two.
     */
    function normalizeModule(id: string, mod: Record<string, unknown>): ModuleState {
        return {
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
            faceWidgets: mod.faceWidgets as Array<Record<string, unknown>> | undefined,
            statusData: mod.statusData as
                | Record<string, Record<string, string | number | boolean>>
                | undefined,
            focused: (mod.focused as boolean) ?? false,
            interlock: mod.interlock === true,
            size: mod.size as ModuleSize | undefined,
            resizable: mod.resizable as ModuleState['resizable'],
            liveUpdatableParams: mod.liveUpdatableParams as string[] | undefined,
        };
    }

    /**
     * Add an engine from server data. Normalises modules to include instanceId.
     */
    function addEngine(data: Record<string, unknown>) {
        const modules: Record<string, ModuleState> = {};
        const rawModules = (data.modules ?? {}) as Record<string, Record<string, unknown>>;
        for (const [id, mod] of Object.entries(rawModules)) {
            modules[id] = normalizeModule(id, mod);
        }

        engines.value.set(data.engine_id as string, {
            engineId: data.engine_id as string,
            name: (data.display_name as string) ?? '',
            online: (data.online as boolean) ?? false,
            running: (data.running as boolean) ?? false,
            activeProfile: (data.active_profile as string) ?? null,
            modules,
            connections: coerceArray<ConnectionState>(data.connections),
            interlocks: coerceArray<InterlockState>(data.interlocks),
            ip: data.ip as string | undefined,
            ips: data.ips as string[] | undefined,
            hostname: data.hostname as string | undefined,
            buildNumber: data.buildNumber as string | undefined,
        });
        engines.value = new Map(engines.value);
    }

    /** Set full config (modules + connections) for an engine — used by lazy loading. */
    function setEngineConfig(
        engineId: string,
        rawModules: Record<string, unknown>,
        rawConnections: unknown,
    ) {
        const engine = engines.value.get(engineId);
        if (!engine) return;

        const modules: Record<string, ModuleState> = {};
        for (const [id, mod] of Object.entries(
            rawModules as Record<string, Record<string, unknown>>,
        )) {
            modules[id] = normalizeModule(id, mod);
        }

        engine.modules = modules;
        engine.connections = coerceArray<ConnectionState>(rawConnections);
        engines.value = new Map(engines.value);
    }

    /**
     * Apply JSON Patch (RFC 6902) operations to an engine's state.
     * Delegates to `applyJsonPatch` from `shared-types` so the walker behaves
     * identically on both sides of the wire — id-based array paths, '-'
     * append, and intermediate auto-creation all live in one place.
     */
    function applyEnginePatch(engineId: string, patchOps: unknown[]) {
        const engine = engines.value.get(engineId);
        if (!engine) return;

        const updated: EngineState = {
            ...engine,
            modules: { ...engine.modules },
            connections: [...engine.connections],
            interlocks: [...(engine.interlocks ?? [])],
        };

        // Normalise raw module shapes the server sends. Three entry points:
        //   - `add /modules/<id>`     — clone/addModule from another browser
        //   - `replace /modules/<id>` — full-module replace
        //   - `replace /modules`      — wholesale dict replace (profile activate)
        // Without this, an imported profile that lacks `instanceId` on its
        // module values produces nodes with `id: undefined` and Vue Flow
        // crashes in `parseNode` (`e.id.toString()`).
        const ops = (patchOps as PatchOp[]).map((op): PatchOp => {
            if (
                (op.op === 'add' || op.op === 'replace') &&
                /^\/modules\/[^/]+$/.test(op.path) &&
                op.value
            ) {
                const moduleId = op.path.split('/')[2];
                return {
                    ...op,
                    value: normalizeModule(moduleId, op.value as Record<string, unknown>),
                };
            }
            if (op.op === 'replace' && op.path === '/modules' && op.value) {
                const raw = op.value as Record<string, Record<string, unknown>>;
                const next: Record<string, ModuleState> = {};
                for (const [id, mod] of Object.entries(raw)) {
                    next[id] = normalizeModule(id, mod);
                }
                return { ...op, value: next };
            }
            return op;
        });

        applyJsonPatch(updated as unknown as Record<string, unknown>, ops);

        engines.value.set(engineId, updated);
        engines.value = new Map(engines.value);
    }

    function setOnline(engineId: string, online: boolean) {
        const engine = engines.value.get(engineId);
        if (!engine || engine.online === online) return;
        // Replace with a new object so Vue's computed caching detects the change
        engines.value.set(engineId, { ...engine, online });
        engines.value = new Map(engines.value);
    }

    /**
     * Clear runtime data when engine goes offline (stats, module health, badges).
     * Does NOT clear `engine.running` — that flag is the persisted user intent
     * (Start/Stop button), authoritative on the manager. Wiping it here would
     * desync the button across an offline/online blip: the engine reconnects
     * still running, but the UI would have forgotten and shown "Start".
     */
    function clearEngineRuntime(engineId: string) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
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

    function setEngineInfo(
        engineId: string,
        info: { ip?: string; ips?: string[]; hostname?: string; buildNumber?: string },
    ) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        let changed = false;
        if (info.ip && engine.ip !== info.ip) {
            engine.ip = info.ip;
            changed = true;
        }
        if (info.ips && JSON.stringify(info.ips) !== JSON.stringify(engine.ips)) {
            engine.ips = info.ips;
            changed = true;
        }
        if (info.hostname && engine.hostname !== info.hostname) {
            engine.hostname = info.hostname;
            changed = true;
        }
        if (info.buildNumber && engine.buildNumber !== info.buildNumber) {
            engine.buildNumber = info.buildNumber;
            changed = true;
        }
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

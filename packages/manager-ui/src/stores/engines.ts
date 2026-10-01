import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
// shared-types is built as CJS (because the engine/manager runtime is CJS).
// Vite's CJS↔ESM interop only synthesizes a default export for the module,
// so named bindings like `import { applyJsonPatch }` fail with
// "X is not exported by …/dist/index.js". Use a namespace import — that
// gives us `esModuleInterop`-style access to the underlying CJS exports.
import * as shared from '@media-router/shared-types';
import type {
    ModuleSize,
    PatchOp,
    ResizableBounds,
    StatusValue,
} from '@media-router/shared-types';
const { applyTreeOp, coerceArray, getAt, splitPath } = shared;

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
    /** Display hint: input consumes EITHER TS family (muxed TS or 302M) —
     *  rendered as a half-orange/half-cyan dot. Plugin-declared. */
    acceptsAnyTs?: boolean;
    /** Exact-match accept list — opts an input out of TS-family leniency
     *  (e.g. ts-splitter takes only genuinely muxed TS). Plugin-declared;
     *  enforced by the engine and mirrored in the connection validator. */
    acceptsStreamTypes?: string[];
    /**
     * Display hint from the engine: hide this port while no edge references
     * it (e.g. mpegts-demuxer legacy positional ports once PID ports exist).
     * Visibility only — the port stays registered engine-side, so existing
     * connections always remain valid.
     */
    hideWhenUnconnected?: boolean;
    /**
     * Display hint from the engine: the port's stream is gone from the live
     * source and the port survives only because a stored connection still
     * references it (ts-splitter PID that left the PMT, ADR-0021). Drawn as
     * an amber dashed dot with a struck-through label; still connectable.
     */
    stale?: boolean;
    /**
     * Structured stream identity for compact pin display (see
     * `utils/portDisplay.ts`): one value shown by priority — in-band name →
     * ISO 639 language → decimal PID — plus a codec chip. `label` stays the
     * full descriptive string (fallback + stats detail).
     */
    streamInfo?: PortStreamInfo;
}

/** Stream identity a port can carry (splitter/demuxer PID ports, muxer
 *  stream inputs). All fields optional — absent means unknown. */
export interface PortStreamInfo {
    /** In-band / operator-set stream name (KLV channel). */
    name?: string;
    /** ISO 639 language code (e.g. `nor`). */
    language?: string;
    pid?: number;
    codec?: string;
    media?: string;
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
    statusData?: Record<string, Record<string, StatusValue>>;
    dynamicStatusSections?: StatusSectionDef[];
    badges?: Array<{ id: string; icon?: string; text: string; color?: string }>;
    /** Probe-discovered option lists for config fields, keyed by `x-optionsFrom`. */
    fieldOptions?: Record<string, Array<{ value: string; label: string }>>;
    faceWidgets?: Array<Record<string, unknown>>;
    focused?: boolean;
    /** Plugin manifest opts into interlock (exclusive-mute) groups. */
    interlock?: boolean;
    /**
     * Plugin opted into user-resizable cards. `false`/undefined = fixed size.
     * Object form carries min/max bounds the plugin set.
     */
    resizable?: boolean | ResizableBounds;
    /**
     * Manifest-declared upload policy. The `imageUpload` widget reads this
     * to set the file picker's `accept` attribute and to decide whether to
     * render the preview as `<img>` (image MIME) or `<video>` (video MIME).
     * Plugins without an upload policy don't get to upload at all.
     */
    uploads?: { extensions: string[]; maxBytes: number };
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

export interface ManagerPathStatus {
    connected: number;
    total: number;
}

/** One live path as the manager sees it: engine source endpoint + the manager listener port it uses. */
export interface EnginePathInfo {
    remote: string;
    listenerPort: number;
}

export interface SystemStats {
    cpu: number; // CPU usage %
    mem: number; // Memory usage %
    temp: number | null; // CPU temperature °C
    undervoltage?: boolean; // Pi under-voltage warning (latched true; omitted otherwise)
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
    /** dgram-comms paths connected vs configured on the engine (issue #692). */
    managerPaths?: ManagerPathStatus;
    /** Live paths with the manager listener port each one uses (issue #692). */
    paths?: EnginePathInfo[];
    /** Sidebar group id — defaults to 'ungrouped' on the server. */
    groupId: string;
    /** Position within the group; ascending. */
    sortOrder: number;
    /** Counts from the manager's info node — valid without the graph loaded. */
    moduleCount?: number;
    connectionCount?: number;
    /** Stored profiles of the engine (name → active flag). */
    profiles?: Record<string, { name: string; active: boolean }>;
}

// --- Store ---

export const useEngineStore = defineStore('engines', () => {
    const engines = ref<Map<string, EngineState>>(new Map());

    const engineList = computed(() => Array.from(engines.value.values()));

    /**
     * Engines bucketed by `groupId` and sorted by `sortOrder`. The sidebar
     * reads from this; building it once per change is cheaper than re-sorting
     * inside each EngineGroup component on every render.
     */
    const enginesByGroup = computed(() => {
        const map = new Map<string, EngineState[]>();
        for (const engine of engines.value.values()) {
            const arr = map.get(engine.groupId) ?? [];
            arr.push(engine);
            map.set(engine.groupId, arr);
        }
        for (const arr of map.values()) {
            arr.sort((a, b) => a.sortOrder - b.sortOrder);
        }
        return map;
    });

    function getEngine(engineId: string): EngineState | undefined {
        return engines.value.get(engineId);
    }

    /**
     * Turn raw server-shape module data into a `ModuleState`. Single point of
     * truth for every per-module field — used by `addEngine` and by tree
     * `add /modules…` ops. Adding a new field means one edit here.
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
            statusData: mod.statusData as ModuleState['statusData'],
            focused: (mod.focused as boolean) ?? false,
            interlock: mod.interlock === true,
            size: mod.size as ModuleSize | undefined,
            resizable: mod.resizable as ModuleState['resizable'],
            uploads: mod.uploads as ModuleState['uploads'],
            liveUpdatableParams: mod.liveUpdatableParams as string[] | undefined,
            error: (mod.error as string | null | undefined) ?? undefined,
            badges: mod.badges as ModuleState['badges'],
            dynamicStatusSections: mod.dynamicStatusSections as ModuleState['dynamicStatusSections'],
            fieldOptions: mod.fieldOptions as ModuleState['fieldOptions'],
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
            managerPaths: data.managerPaths as ManagerPathStatus | undefined,
            paths: (data.paths as EnginePathInfo[] | undefined) ?? [],
            groupId: (data.group_id as string) ?? 'ungrouped',
            sortOrder: (data.sort_order as number) ?? 0,
        });
        engines.value = new Map(engines.value);
    }

    /**
     * Apply a reorder update from the server. Bulk-shaped because the
     * sidebar drag often shifts multiple engines (the moved one plus the
     * gap-closers in the source/destination groups).
     */
    function applyReorder(
        updates: Array<{ engineId: string; groupId: string; sortOrder: number }>,
    ) {
        let changed = false;
        for (const u of updates) {
            const engine = engines.value.get(u.engineId);
            if (!engine) continue;
            if (engine.groupId !== u.groupId || engine.sortOrder !== u.sortOrder) {
                engines.value.set(u.engineId, {
                    ...engine,
                    groupId: u.groupId,
                    sortOrder: u.sortOrder,
                });
                changed = true;
            }
        }
        if (changed) engines.value = new Map(engines.value);
    }
    /**
     * Apply tree ops (engine-relative JSON Patch paths) to an engine's state:
     * id-based array paths, idempotent `-` appends by id. Module values are
     * normalised on the way in. `skipUnchanged` drops an echo that changes
     * nothing, so a slider drag does not rebuild the Map per echo.
     */
    function applyEnginePatch(engineId: string, patchOps: unknown[], opts?: { skipUnchanged?: boolean }) {
        const engine = engines.value.get(engineId);
        if (!engine) return;

        let ops = (patchOps as PatchOp[]).map((op): PatchOp => {
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
            if (op.op !== 'remove' && op.path === '/modules' && op.value) {
                const raw = op.value as Record<string, Record<string, unknown>>;
                const next: Record<string, ModuleState> = {};
                for (const [id, mod] of Object.entries(raw)) {
                    next[id] = normalizeModule(id, mod);
                }
                return { ...op, value: next };
            }
            return op;
        });
        if (opts?.skipUnchanged) {
            ops = ops.filter(
                (op) =>
                    op.op === 'remove' ||
                    JSON.stringify(getAt(engine, splitPath(op.path))) !== JSON.stringify(op.value),
            );
            if (ops.length === 0) return;
        }

        const updated: EngineState = {
            ...engine,
            modules: { ...engine.modules },
            connections: [...engine.connections],
            interlocks: [...(engine.interlocks ?? [])],
        };
        for (const op of ops) applyTreeOp(updated as unknown as Record<string, unknown>, op);

        engines.value.set(engineId, updated);
        engines.value = new Map(engines.value);
    }

    /** The engine, created blank if the tree names one the store does not know yet. */
    function ensureEngine(engineId: string): EngineState {
        let engine = engines.value.get(engineId);
        if (!engine) {
            engine = {
                engineId,
                name: engineId,
                online: false,
                running: false,
                activeProfile: null,
                modules: {},
                connections: [],
                interlocks: [],
                paths: [],
                groupId: 'ungrouped',
                sortOrder: 0,
            };
            engines.value.set(engineId, engine);
            engines.value = new Map(engines.value);
        }
        return engine;
    }

    /** Replace some engine-level fields (the tree's `info` node). */
    function patchInfo(engineId: string, fields: Partial<EngineState>) {
        const engine = ensureEngine(engineId);
        engines.value.set(engineId, { ...engine, ...fields });
        engines.value = new Map(engines.value);
    }

    /** Runtime field of one module, written in place — the hot path (health, statusData…). */
    function applyRuntimeOp(engineId: string, moduleId: string, op: PatchOp) {
        const mod = engines.value.get(engineId)?.modules[moduleId];
        if (mod) applyTreeOp(mod as unknown as Record<string, unknown>, op);
    }

    function setSystem(engineId: string, system: SystemStats | undefined) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        engine.system = system;
        engines.value = new Map(engines.value);
    }

    /** Forget an engine's graph once nothing subscribes to it any more. */
    function dropGraph(engineId: string, branches: Array<'modules' | 'connections' | 'interlocks' | 'profiles'>) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        const next: EngineState = { ...engine };
        if (branches.includes('modules')) next.modules = {};
        if (branches.includes('connections')) next.connections = [];
        if (branches.includes('interlocks')) next.interlocks = [];
        if (branches.includes('profiles')) next.profiles = undefined;
        engines.value.set(engineId, next);
        engines.value = new Map(engines.value);
    }
    function setRunning(engineId: string, running: boolean) {
        const engine = engines.value.get(engineId);
        if (!engine || engine.running === running) return;
        engines.value.set(engineId, { ...engine, running });
        engines.value = new Map(engines.value);
    }

    function removeEngine(engineId: string) {
        engines.value.delete(engineId);
        engines.value = new Map(engines.value);
    }

    /**
     * Swap an engine's Map key + internal `engineId` after a server-side
     * rename. Insertion order is preserved across all engines so the sidebar
     * doesn't reshuffle as a side effect of the rekey — we rebuild the Map
     * in the original sequence with the renamed entry substituted in place.
     */
    function renameEngine(oldEngineId: string, newEngineId: string) {
        if (oldEngineId === newEngineId) return;
        const engine = engines.value.get(oldEngineId);
        if (!engine || engines.value.has(newEngineId)) return;
        const next = new Map<string, EngineState>();
        for (const [key, value] of engines.value) {
            if (key === oldEngineId) {
                next.set(newEngineId, { ...value, engineId: newEngineId });
            } else {
                next.set(key, value);
            }
        }
        engines.value = next;
    }

    /** Remove a connection from an engine's local state. */
    function removeConnection(engineId: string, connectionId: string) {
        const engine = engines.value.get(engineId);
        if (!engine) return;
        engine.connections = engine.connections.filter((c) => c.id !== connectionId);
        engines.value = new Map(engines.value);
    }

    return {
        engines,
        engineList,
        enginesByGroup,
        getEngine,
        addEngine,
        applyReorder,
        applyEnginePatch,
        ensureEngine,
        patchInfo,
        applyRuntimeOp,
        setSystem,
        dropGraph,
        setRunning,
        removeEngine,
        removeConnection,
        renameEngine,
    };
});

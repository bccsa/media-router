// ============================================================================
// Media Router v2.0 — Shared Type Definitions
// ============================================================================

export { createLogger, setLogTap } from './logger.js';
export { ExponentialBackoff } from './ExponentialBackoff.js';
export {
    PatchOpSchema,
    PatchOpsSchema,
    DgramWireMessageSchema,
    DgramDataSchema,
    EngineRunningStateSchema,
    LcpEngineCommandSchema,
    DynamicPortsSchema,
    RebootFailedSchema,
    PatchEnvelopeSchema,
    // Manager Socket RPC payloads — every event in rpcHandlers.ts has its
    // schema exported here so the manager-ui can build matching payloads.
    EngineIdSchema,
    CreateEngineSchema,
    UpdateEngineSchema,
    DeleteEngineSchema,
    ReorderEnginesSchema,
    CreateGroupSchema,
    UpdateGroupSchema,
    DeleteGroupSchema,
    ReorderGroupsSchema,
    ListProfilesSchema,
    CreateManagerProfileSchema,
    DeleteProfileSchema,
    ActivateProfileSchema,
    ProfileQuerySchema,
    RollbackSchema,
    DeviceListSchema,
    CreateEngineProfileSchema,
    EngineIdPayloadSchema,
    ModuleRestartPayloadSchema,
    BrowserPatchPayloadSchema,
    InterlockSchema,
    InterlocksSchema,
    validateInterlocksInvariants,
    safeParse,
    validated,
} from './validation.js';
export type { InterlockInvariantIssue } from './validation.js';

// --- Error Classes ----------------------------------------------------------

/** Base error for all Media Router errors. */
export class MediaRouterError extends Error {
    /** Machine-readable error code for programmatic handling. */
    public readonly code: string;

    constructor(message: string, code = 'MEDIA_ROUTER_ERROR') {
        super(message);
        this.name = 'MediaRouterError';
        this.code = code;
    }
}

/** IPC request to a child process timed out. */
export class IpcTimeoutError extends MediaRouterError {
    constructor(action: string, timeoutMs: number) {
        super(`IPC request '${action}' timed out after ${timeoutMs}ms`, 'IPC_TIMEOUT');
        this.name = 'IpcTimeoutError';
    }
}

/** GStreamer pipeline failed to start or crashed. */
export class PipelineError extends MediaRouterError {
    constructor(
        message: string,
        public readonly pipelineDescription?: string,
    ) {
        super(message, 'PIPELINE_ERROR');
        this.name = 'PipelineError';
    }
}

/** Module configuration is invalid. */
export class ConfigValidationError extends MediaRouterError {
    constructor(
        message: string,
        public readonly validationErrors?: string[],
    ) {
        super(message, 'CONFIG_VALIDATION_ERROR');
        this.name = 'ConfigValidationError';
    }
}

/** Connection to manager or engine failed. */
export class ConnectionError extends MediaRouterError {
    constructor(
        message: string,
        public readonly target?: string,
    ) {
        super(message, 'CONNECTION_ERROR');
        this.name = 'ConnectionError';
    }
}

/** Module lifecycle error (failed to start, stop, or transition). */
export class ModuleLifecycleError extends MediaRouterError {
    constructor(
        message: string,
        public readonly moduleId?: string,
        public readonly phase?: string,
    ) {
        super(message, 'MODULE_LIFECYCLE_ERROR');
        this.name = 'ModuleLifecycleError';
    }
}

/** PipeWire/PulseAudio command failed. */
export class AudioRoutingError extends MediaRouterError {
    constructor(
        message: string,
        public readonly command?: string,
    ) {
        super(message, 'AUDIO_ROUTING_ERROR');
        this.name = 'AudioRoutingError';
    }
}

// --- Patch System -----------------------------------------------------------

/** JSON Patch operation (RFC 6902 subset). */
export interface PatchOp {
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
}

// --- Utilities --------------------------------------------------------------

/** Convert an unknown caught value to a human-readable error string. */
export function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Coerce an unknown value to an array. Recovers from the historical
 * applyJsonPatch bug where `/-` on a missing field produced `{ "-": value }`
 * by walking object values and keeping only object items.
 *
 * Used at every server→store ingestion point so consumers can trust that
 * `connections` / `interlocks` are arrays without runtime guards.
 */
export function coerceArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[];
    if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).filter(
            (v): v is T => !!v && typeof v === 'object' && !Array.isArray(v),
        ) as T[];
    }
    return [];
}

/** A path segment that addresses an array element ('-' append, or numeric index). */
function isArrayKey(part: string): boolean {
    return part === '-' || /^\d+$/.test(part);
}

/**
 * Resolve a path segment against an array. Numeric segments are direct indices;
 * non-numeric segments are matched against array items' `.id` property.
 * Returns -1 if not found.
 */
function arrIdx(arr: unknown[], key: string): number {
    const n = parseInt(key, 10);
    if (!isNaN(n)) return n;
    return (arr as Array<{ id?: unknown }>).findIndex((item) => item?.id === key);
}

/**
 * Apply JSON Patch operations to a nested object.
 *
 * Supports: replace, add (with intermediate creation + array append via '-'),
 * remove. Array segments resolve by numeric index OR by `.id` lookup, both
 * during walk and at the final segment — id paths survive concurrent array
 * mutations and are what the manager broadcasts to browsers.
 *
 * On `add`, missing intermediates are created as an array if the next segment
 * is array-shaped ('-' or numeric), otherwise an object. Without this, an op
 * like `/connections/-` on a config missing `connections` would silently
 * produce `connections: { "-": value }` — the same shape that bit `interlocks`
 * historically (see `coerceArray`).
 */
export function applyJsonPatch(obj: Record<string, unknown> | null, ops: PatchOp[]): void {
    if (!obj) return;
    for (const op of ops) {
        const parts = op.path.split('/').filter(Boolean);
        const last = parts.pop();
        if (!last) continue;

        let target: Record<string, unknown> | unknown[] = obj;
        let valid = true;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (Array.isArray(target)) {
                const idx = arrIdx(target, part);
                const next = idx >= 0 ? target[idx] : undefined;
                if (next == null || typeof next !== 'object') {
                    valid = false;
                    break;
                }
                target = next as Record<string, unknown> | unknown[];
            } else {
                const cur = (target as Record<string, unknown>)[part];
                if (cur == null || typeof cur !== 'object') {
                    if (op.op === 'add') {
                        const nextSeg = i + 1 < parts.length ? parts[i + 1] : last;
                        const created: Record<string, unknown> | unknown[] = isArrayKey(nextSeg)
                            ? []
                            : {};
                        (target as Record<string, unknown>)[part] = created;
                        target = created;
                    } else {
                        valid = false;
                        break;
                    }
                } else {
                    target = cur as Record<string, unknown> | unknown[];
                }
            }
        }
        if (!valid) continue;

        switch (op.op) {
            case 'add':
            case 'replace':
                if (Array.isArray(target)) {
                    if (last === '-') {
                        target.push(op.value);
                    } else {
                        const idx = arrIdx(target, last);
                        if (idx >= 0) target[idx] = op.value;
                        // No id match and not '-' → drop, don't poison the array
                        // with a literal string key.
                    }
                } else if (last === '-') {
                    // '-' is array-only. Skip rather than poisoning the object.
                } else {
                    (target as Record<string, unknown>)[last] = op.value;
                }
                break;
            case 'remove':
                if (Array.isArray(target)) {
                    const idx = arrIdx(target, last);
                    if (idx >= 0) target.splice(idx, 1);
                } else {
                    delete (target as Record<string, unknown>)[last];
                }
                break;
        }
    }
}

/** Default edge colors for stream types in the routing editor. */
export const STREAM_TYPE_COLORS: Record<string, string> = {
    'audio/pcm': '#3b82f6',
    'audio/302m': '#06b6d4',
    'muxed/mpegts': '#f59e0b',
    'video/raw': '#10b981',
};

// --- Stream Types -----------------------------------------------------------

/** Media stream type — determines routing domain and port compatibility. */
export type StreamType =
    | 'audio/pcm' // Raw PCM audio (PipeWire routing)
    | 'audio/302m' // PCM-in-MPEG-TS (SMPTE 302M) over the loopback bus — PTS-preserving
    | 'audio/opus' // Encoded Opus audio
    | 'audio/aac' // Encoded AAC audio
    | 'video/raw' // Raw video frames
    | 'video/h264' // Encoded H.264 video
    | 'video/h265' // Encoded H.265/HEVC video
    | 'muxed/mpegts' // MPEG-TS container (audio + video + subs)
    | 'text/subtitle' // Subtitle stream (SRT, ASS, etc.)
    | 'data/generic'; // Generic data (metadata, control, etc.)

/**
 * TS-family stream types: both are valid MPEG-TS on the wire. `audio/302m`
 * is a semantic flag ("this TS carries SMPTE-302M PCM audio — wire it to
 * audio pins for mixing") — it must still be able to ride any TS transport
 * (SRT/RIST/IP outputs). Ports that want stricter intake than the family
 * rule declare `ModulePort.acceptsStreamTypes` (e.g. 302M mixing pins take
 * only `audio/302m`-declared sources; a muxed TS goes through a transcoder
 * first).
 */
const TS_FAMILY: ReadonlySet<string> = new Set(['muxed/mpegts', 'audio/302m']);

/**
 * Port wiring compatibility: exact match, or both sides in the TS family.
 * Single source of truth — used by the engine's PortRegistry AND the
 * manager-ui connection validator (import it, don't duplicate the rule).
 */
export function streamTypesCompatible(source: string, sink: string): boolean {
    return source === sink || (TS_FAMILY.has(source) && TS_FAMILY.has(sink));
}

// --- Module Ports -----------------------------------------------------------

/** A typed input or output port on a module. */
export interface ModulePort {
    /** Unique within module (e.g. "audio_out_1"). */
    id: string;
    /** Whether data flows into or out of this port. */
    direction: 'input' | 'output';
    /** Stream type — determines which ports can connect. */
    streamType: StreamType;
    /** For audio/pcm ports — channel configuration. */
    channelConfig?: {
        channels: number;
    };
    /** For muxed/mpegts ports — stream content description. */
    mpegtsConfig?: {
        streamInfo?: MpegTsStreamInfo;
    };
    /** Human-readable label for UI display. */
    label: string;
    /**
     * Max connections allowed on this port.
     * -1 = unlimited (default), 0 = disabled (hidden), 1+ = fixed limit.
     */
    maxConnections?: number;
    /** Whether the user can change maxConnections at runtime (e.g. N-1 mixer). */
    userConfigurable?: boolean;
    /**
     * Exact-match accept list for an INPUT port — opts out of TS-family
     * leniency. Plugin-declared: set it where family-compatible wiring is a
     * dead end (e.g. the ts-splitter's input takes only genuinely muxed TS —
     * a 302M stream is valid TS but has nothing to split). Absent = the
     * normal `streamTypesCompatible` rule applies.
     */
    acceptsStreamTypes?: StreamType[];
}

// --- Connections ------------------------------------------------------------

/** A single channel mapping entry: source channel → destination channel. */
export interface ChannelMapEntry {
    /** 0-indexed source channel. */
    srcChannel: number;
    /** 0-indexed destination channel. */
    dstChannel: number;
    /** Optional per-channel gain (0.0–2.0, default 1.0). */
    gain?: number;
}

// --- Module Runtime State ---------------------------------------------------

/** Overall module health for the state icon. */
export type ModuleHealth = 'ok' | 'warning' | 'error' | 'stopped';

/** Runtime state of a module instance, reported by the engine. */
export interface ModuleRuntimeState {
    /** Whether the module's child process is running. */
    running: boolean;
    /** Whether the module has completed initialisation and is ready. */
    ready: boolean;
    /** Overall module health for state icon. */
    health: ModuleHealth;
    /** True = restart-required config changes are waiting to be applied. */
    pendingRestart: boolean;
    /** Params that are currently live-updatable (reported at runtime). */
    liveUpdatableParams?: string[];
    /** VU meter levels per channel (dBFS, negative values). */
    vuData?: number[];
    /** SRT connection statistics (when module is SRT-based). */
    srtStats?: SrtStatistics;
    /** RIST connection statistics (when module is RIST-based). */
    ristStats?: RistStatistics;
    /** Generic status data — keyed by section ID, values are key-value pairs. */
    statusData?: Record<string, Record<string, string | number | boolean>>;
    /** Dynamic status sections added at runtime (e.g. per-caller SRT stats). */
    dynamicStatusSections?: Array<{
        id: string;
        label: string;
        fields: Array<{ key: string; label: string; unit?: string }>;
    }>;
    /** Small icon+text indicators shown on the module face. */
    badges?: ModuleBadge[];
    /**
     * Probe-discovered option lists for config fields, keyed by the field's
     * `x-optionsFrom` value (e.g. an HLS player reports detected audio /
     * subtitle languages). The settings panel renders these as multi-selects.
     */
    fieldOptions?: Record<string, Array<{ value: string; label: string }>>;
    /**
     * Error/warning message backing the health state. `null` means
     * explicitly cleared — it must survive JSON serialization (undefined
     * keys are dropped, and per-field mergers downstream would keep stale
     * text forever; field case 2026-08-02: "can't keep up (0/50 fps)"
     * displayed on a healthy module across engine restarts).
     */
    error?: string | null;
    /** Non-fatal warnings (e.g. stream layout mismatches). */
    warnings?: string[];
}

/** A small icon+text badge displayed on the module card face. */
export interface ModuleBadge {
    id: string;
    /** Lucide icon name (kebab-case). Optional. */
    icon?: string;
    /** Short text displayed next to the icon. */
    text: string;
    /** CSS color for the badge. Defaults to text-muted. */
    color?: string;
}

/** A status section declared in the plugin manifest. */
export interface StatusSection {
    /** Unique section ID (e.g. "srt", "rist"). */
    id: string;
    /** Human-readable section label. */
    label: string;
    /** Fields displayed in this section. */
    fields: StatusField[];
}

/** A single field within a status section. */
export interface StatusField {
    /** Key in the statusData object. */
    key: string;
    /** Human-readable label. */
    label: string;
    /** Unit suffix for display (e.g. "kbps", "ms", "%"). */
    unit?: string;
    /** How to format the value. */
    format?: 'number' | 'percent' | 'duration' | 'bytes';
}

/** SRT connection statistics. */
export interface SrtStatistics {
    /** Bitrate in kbps. */
    bitrate: number;
    /** Round-trip time in ms. */
    rtt: number;
    /** Packet loss ratio (0.0–1.0). */
    loss: number;
    /** Total retransmitted packets. */
    retransmits: number;
    /** Number of connected peers. */
    connections: number;
}

/** RIST connection statistics. */
export interface RistStatistics {
    /** Bitrate in kbps. */
    bitrate: number;
    /** Round-trip time in ms. */
    rtt: number;
    /** Quality score (0–100). */
    quality: number;
    /** Packet loss ratio (0.0–1.0). */
    loss: number;
}

// --- MPEG-TS Stream Info ----------------------------------------------------

/** Describes the content of an MPEG-TS stream on a port. */
export interface MpegTsStreamInfo {
    /** "static" = declared default; "probed" = detected from live stream. */
    source: 'static' | 'probed';
    /** ISO timestamp of last probe (only when source = "probed"). */
    probedAt?: string;
    /** Elementary streams in the MPEG-TS. */
    streams: MpegTsElementaryStreamInfo[];
    /** MPEG-TS program table (only when source = "probed"). */
    programs?: MpegTsProgram[];
    /** True = port accepts/produces any MPEG-TS content. */
    acceptsAny?: boolean;
}

/** An MPEG-TS program from the PAT/PMT. */
export interface MpegTsProgram {
    programNumber: number;
    pcrPid: number;
    streamPids: number[];
}

/** Describes one elementary stream within an MPEG-TS. */
export interface MpegTsElementaryStreamInfo {
    type: 'video' | 'audio' | 'subtitle' | 'data';
    /** MPEG-TS PID (populated when probed). */
    pid?: number;
    /** Codec identifier (e.g. "h264", "opus", "aac"). */
    codec?: string;
    /** Bitrate in kbps (measured when probed, advisory when static). */
    bitrate?: number;
    /** ISO 639 language code. */
    language?: string;
    /** Video resolution. */
    resolution?: { width: number; height: number };
    /** Video framerate. */
    framerate?: number;
    /** Audio channel count (e.g. 2 = stereo, 6 = 5.1). */
    channels?: number;
    /** Audio sample rate in Hz. */
    sampleRate?: number;
    /** Subtitle format (e.g. "dvb_subtitle", "dvb_teletext"). */
    format?: string;
    /** Data stream format (e.g. "dsmcc", "klv"). */
    dataFormat?: string;
}

// --- Audio Device Settings --------------------------------------------------

/** Per-device audio configuration applied via PipeWire. */
export interface AudioDeviceSettings {
    /** Sample rate in Hz (e.g. 48000). */
    sampleRate: number;
    /** Bit depth (e.g. 16, 24, 32). */
    bitDepth: number;
    /** Buffer size in frames. */
    bufferSize: number;
}

// --- Generic device provider -----------------------------------------------

export interface Device {
    /** Stable identifier — stored as the config value. */
    name: string;
    /** Pre-formatted label shown in dropdowns; provider owns the format. */
    label: string;
    /** Type-specific fields (direction, channels, formats, ...). */
    meta?: Record<string, unknown>;
}

// --- Communication ----------------------------------------------------------

/** dgram-comms wire protocol message envelope. */
export interface DgramMessage {
    type: 'data' | 'keepAlive' | 'ack' | 'connect' | 'connected' | 'reset';
    /** Client identifier. */
    clientID: string;
    /** Encryption IV (hex string). */
    iv?: string;
    /** Multi-path sequence number for dedup. */
    seq?: number;
    data: {
        topic?: string;
        message?: unknown;
        ackID?: number;
        socketID?: string;
    };
}

/** A manager connection profile stored on the engine. */
export interface ManagerConnectionProfile {
    /** Profile name (e.g. "Production Manager"). */
    name: string;
    /** One or more UDP paths to the manager (for redundancy). */
    paths: ManagerPath[];
    /** Shared encryption key (password). */
    encryptionKey: string;
}

/** A single UDP path to the manager. */
export interface ManagerPath {
    /** Manager hostname or IP. */
    host: string;
    /** Manager dgram-comms port. */
    port: number;
    /** Optional network interface to bind to (e.g. "eth0"). */
    bindInterface?: string;
    /** Optional local address to bind to. */
    bindAddress?: string;
}

// --- Control IPC (Engine ↔ Child Process) -----------------------------------

/** Message exchanged between engine and GStreamer child process via Node.js IPC. */
export interface ControlIpcMessage {
    /** Unique message ID for request/response correlation. */
    id: string;
    /** Message category. */
    type: 'request' | 'response' | 'event';
    /** Action name (e.g. "startPipeline", "setElementProperty", "stateChange", "vuData"). */
    action: string;
    /** Action-specific payload. */
    data?: unknown;
}

// --- Plugin Manifest --------------------------------------------------------

/** Plugin manifest from package.json `mediaRouter` field. */
export interface PluginManifest {
    /** Unique plugin identifier (e.g. "srt-input"). */
    pluginId: string;
    /** Human-readable name for UI. */
    displayName: string;
    /** Short description. */
    description: string;
    /** Plugin category for grouping in UI. */
    category: 'protocol' | 'codec' | 'processing' | 'utility';
    /** Supported CPU architectures. */
    architectures: string[];
    /** Declared input/output ports. */
    ports: ModulePort[];
    /** JSON Schema for module configuration. */
    configSchema: Record<string, unknown>;
    /** Status sections to display on the module node in the routing editor. */
    statusSections?: StatusSection[];
    /** Path to engine-side module implementation. */
    engine: string;
    /** Optional path to manager-side config component. */
    manager?: string;
    /** Optional path to UI node component. */
    ui?: string;
    /** Optional path to LCP control component. */
    lcp?: string;
    /** LCP display type: "mixer-strip", "meter-only", "video-monitor", etc. */
    lcpType?: string;
    /**
     * Opt-in flag: module is eligible for interlock groups (exclusive-mute).
     * Requires a live-updatable boolean `audioEnabled` in configSchema.
     */
    interlock?: boolean;
    /**
     * Opt-in flag: user can resize the module card on the routing view.
     * Either `true` (default bounds) or an object with explicit bounds.
     * When enabled, per-instance size is stored at `config.modules.<id>.size`.
     */
    resizable?: boolean | ResizableBounds;
    /**
     * Opt-in upload policy used by the generic `plugin:upload` RPC + the
     * `imageUpload` widget. Plugins set their own allowlist and size cap
     * here so manager + engine stay agnostic — adding video support to
     * one plugin doesn't widen the policy for every other plugin in the
     * registry. Absent ⇒ the plugin can't upload (the service rejects).
     */
    uploads?: UploadsPolicy;
}

/**
 * Upload policy declared on a plugin manifest. Both fields are concrete,
 * the field names dropped the `x-` prefix when migrating from schema-ext
 * to the manifest top-level (it lives next to ports/configSchema, not
 * inside the JSON Schema).
 */
export interface UploadsPolicy {
    /** Allowed file extensions, leading dot, lowercase. E.g. `[".png", ".mp4"]`. */
    extensions: string[];
    /** Max upload size in bytes. */
    maxBytes: number;
}

/** User-resizable plugin bounds (pixels). All fields optional. */
export interface ResizableBounds {
    minWidth?: number;
    minHeight?: number;
    maxWidth?: number;
    maxHeight?: number;
}

/** Stored size of a module instance on the routing view. */
export interface ModuleSize {
    width: number;
    height: number;
}

// --- Interlocks -------------------------------------------------------------

/** An exclusive-mute group: only one member may have audioEnabled=true. */
export interface Interlock {
    /** Stable unique id. */
    id: string;
    /** User-facing name. */
    name: string;
    /** Module IDs in this group. Order is used for priority on conflict resolution. */
    members: string[];
    /** Optional accent color for UI badge/ring. */
    color?: string;
}

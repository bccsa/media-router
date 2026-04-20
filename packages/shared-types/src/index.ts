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
    PatchEnvelopeSchema,
    CreateEngineSchema,
    UpdateEngineSchema,
    CreateManagerProfileSchema,
    RollbackSchema,
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
 * Apply JSON Patch operations to a nested object.
 * Supports: replace, add (with intermediate creation + array append via '-'), remove.
 */
export function applyJsonPatch(obj: Record<string, unknown> | null, ops: PatchOp[]): void {
    if (!obj) return;
    for (const op of ops) {
        const parts = op.path.split('/').filter(Boolean);
        const last = parts.pop();
        if (!last) continue;

        let target: Record<string, unknown> = obj;
        let valid = true;
        for (const part of parts) {
            if (target[part] == null || typeof target[part] !== 'object') {
                if (op.op === 'add') {
                    target[part] = {};
                } else {
                    valid = false;
                    break;
                }
            }
            target = target[part] as Record<string, unknown>;
        }
        if (!valid) continue;

        switch (op.op) {
            case 'add':
            case 'replace':
                if (last === '-' && Array.isArray(target)) {
                    (target as unknown[]).push(op.value);
                } else {
                    target[last] = op.value;
                }
                break;
            case 'remove':
                if (Array.isArray(target)) {
                    let idx = parseInt(last, 10);
                    // Support ID-based removal: find array element by .id property
                    if (isNaN(idx)) {
                        idx = (target as Array<Record<string, unknown>>).findIndex(
                            (item) => item?.id === last,
                        );
                    }
                    if (idx >= 0) target.splice(idx, 1);
                } else {
                    delete target[last];
                }
                break;
        }
    }
}

/** Default edge colors for stream types in the routing editor. */
export const STREAM_TYPE_COLORS: Record<string, string> = {
    'audio/pcm': '#3b82f6',
    'muxed/mpegts': '#f59e0b',
    'video/raw': '#10b981',
};

// --- Stream Types -----------------------------------------------------------

/** Media stream type — determines routing domain and port compatibility. */
export type StreamType =
    | 'audio/pcm' // Raw PCM audio (PipeWire routing)
    | 'audio/opus' // Encoded Opus audio
    | 'audio/aac' // Encoded AAC audio
    | 'video/raw' // Raw video frames
    | 'video/h264' // Encoded H.264 video
    | 'video/h265' // Encoded H.265/HEVC video
    | 'muxed/mpegts' // MPEG-TS container (audio + video + subs)
    | 'text/subtitle' // Subtitle stream (SRT, ASS, etc.)
    | 'data/generic'; // Generic data (metadata, control, etc.)

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
    /** Error message if health is "error". */
    error?: string;
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

// --- Communication ----------------------------------------------------------

/** dgram-comms wire protocol message envelope. */
export interface DgramMessage {
    type: 'data' | 'keepAlive' | 'ack' | 'connect' | 'connected';
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

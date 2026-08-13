import type { PluginManifest, StreamType } from '@media-router/shared-types';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { BusAttachTarget, LiveSwapTarget } from '../child-process/UnixFdFanoutController.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';
import type { ClockAuthority } from '../child-process/ClockAuthority.js';

/**
 * A dynamically resolved module port — the one shared shape every plugin's
 * `getDynamicPorts` returns (previously re-declared per plugin). Field
 * semantics match `ModulePort` in shared-types plus the engine-side apply
 * hints (`requiresOrderedApply`) and UI display hints.
 */
export interface DynamicPort {
    id: string;
    direction: 'input' | 'output';
    streamType: StreamType;
    label: string;
    /** -1 = unlimited, 0 = disabled/hidden, 1+ = fixed limit. */
    maxConnections?: number;
    /** Apply this port's outgoing connections in topological order after the
     *  producer pipeline is up (lazy port allocation on pipeline start). */
    requiresOrderedApply?: boolean;
    /** Exact-match accept list — opts an input out of TS-family leniency.
     *  See `ModulePort.acceptsStreamTypes`. */
    acceptsStreamTypes?: StreamType[];
    /** Display hint: input consumes EITHER TS family (muxed TS or 302M) —
     *  rendered as a dual-color dot. Only for decode-capable inputs. */
    acceptsAnyTs?: boolean;
    /** Structured stream identity for compact pin display in the UI (one
     *  value by priority: in-band name → ISO 639 language → decimal PID,
     *  plus a codec chip). `label` stays the full descriptive string. */
    streamInfo?: {
        name?: string;
        language?: string;
        pid?: number;
        codec?: string;
        media?: string;
    };
}

/** Services passed to a plugin's static `registerServices` hook (once per plugin class). */
export interface EngineServices {
    pipeWire: PipeWireManager;
    mediaRouter: MediaRouter;
    processManager: ProcessManager;
    deviceProviders: DeviceProviderRegistry;
    /** Shared net-clock for cross-pipeline A/V sync (see `PipelineDescription.clockSync`).
     *  Optional: absent in test harnesses and on engines built before this; a
     *  `clockSync` pipeline then simply runs unsynced. */
    clockAuthority?: ClockAuthority;
    /** Engine-wide time-sync contract (see `EngineConfig.timeSyncContract` and
     *  `PipelineDescription.timeSyncContract`). When on it SUPERSEDES the
     *  per-module `clockSync` opt-in: `GstPluginBase` marks the description for
     *  the contract instead of resolving a net clock, so `clockAuthority` is
     *  never contacted. Off → the legacy `clockSync` path, unchanged. The
     *  engine resolves it on by default; absent here (test harnesses, engines
     *  built before this) reads as off. */
    timeSyncContract?: boolean;
    /** Engine-wide default playout offset D in ms (ADR-0005 decision 4, see
     *  `EngineConfig.playoutOffsetMs`). Presentation modules resolve their sink
     *  `ts-offset` from it via `effectivePlayoutOffsetMs`, which also consults
     *  the route head's override. Only read when `timeSyncContract` is on;
     *  absent (test harnesses, older engines) falls back to the 300 ms
     *  default. */
    playoutOffsetMs?: number;
}

/**
 * Optional static hooks a plugin class may expose. Both run at most once per
 * plugin class during load:
 * - `initManifest(manifest)` — probe the host for runtime capabilities and
 *   mutate the manifest before any module instances are created (used by
 *   video-encoder to detect available HW encoders, audio-encoder to detect
 *   supported codecs, etc.).
 * - `registerServices(services)` — register engine-wide contributions like
 *   device providers (used by audio-input/output to expose source/sink
 *   lists to the manager-UI).
 */
export interface PluginClassStatics {
    initManifest?(manifest: PluginManifest): void | Promise<void>;
    registerServices?(services: EngineServices): void | Promise<void>;
}

/** Runtime-discovered plugin class: a constructable PluginModule with optional static hooks. */
export type PluginConstructor = (new () => PluginModule) & PluginClassStatics;

/** Services passed to each module instance's `onInit` — `EngineServices` plus the instance id. */
export interface ModuleServices extends EngineServices {
    instanceId: string;
}

/**
 * Interface that every plugin's engine module must implement.
 */
export interface PluginModule {
    /** Initialise with config and engine services. Called once before start. */
    onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void>;
    /** Start the module (begin processing). */
    onStart(): Promise<void>;
    /** Stop the module (halt processing, release resources). */
    onStop(): Promise<void>;
    /** Destroy the module (final cleanup). */
    onDestroy(): Promise<void>;
    /** Return current runtime state. */
    getState(): import('@media-router/shared-types').ModuleRuntimeState;
    /** Return list of config params that can be changed without restart. */
    getLiveUpdatableParams(): string[];
    /**
     * Refine live-updatability per change. Only consulted for params already in
     * `getLiveUpdatableParams()`; returning false routes that change down the
     * pending-restart path instead. Lets a structured param be live for some
     * edits but not others — e.g. the mpegts-muxer's stream arrays, where a
     * rename is a live KLV push but adding/removing an entry needs a rebuild.
     */
    isLiveChange?(key: string, newValue: unknown, oldValue: unknown): boolean;
    /** Apply live config changes (only for params in getLiveUpdatableParams). */
    onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void>;
    /**
     * The playout offset D of the route this module consumes changed — the
     * ROUTE HEAD's `playoutOffsetMs` was edited (ADR-0005 decision 4). Fanned
     * out by `MediaRouter.notifyPlayoutOffsetChanged` to every consumer of that
     * producer, so both legs of a route re-anchor together. Presentation
     * modules re-push their sink `ts-offset`; everyone else omits it.
     */
    onRoutePlayoutOffsetChanged?(): Promise<void>;
    /** Return PipeWire node names for audio routing (single-port modules). */
    getPipeWireNodes?(): { source?: string; sink?: string };
    /** Return PipeWire node names for a specific port (multi-port modules like N-1 mixer). */
    getPipeWireNodeForPort?(portId: string): { source?: string; sink?: string };
    /**
     * Return dynamic ports based on config (overrides manifest ports).
     *
     * `config` is the module instance's authoritative config, passed in by the
     * engine. The engine resolves ports BEFORE a module starts (so connections
     * can be registered up-front), at which point the plugin's own `this.config`
     * is still empty — `onInit` only applies it during start. Reading the passed
     * `config` therefore yields the correct port set even pre-start. Implementors
     * should default the parameter to `this.config` so direct/test calls still
     * work.
     */
    getDynamicPorts?(config?: Record<string, unknown>): DynamicPort[];
    /** Return the GStreamer child process (for MPEG-TS piping). */
    getChildProcess?(): GstChildProcess | null;
    /**
     * Where the BusFanoutCoordinator sends this producer's unixfd
     * `bus_attach`/`bus_detach` commands. Defaults to the gst child process
     * (GstPluginBase); a non-GStreamer producer overrides it with its own
     * fan-out controller (hls-player → UnixFdFanoutController).
     */
    getBusAttachTarget?(): BusAttachTarget | null;
    /** Count of running child processes owned by this module. */
    getProcessCount?(): number;
    /**
     * Opt a SINGLE-INPUT bus sink into live input swapping: when the operator
     * re-wires the given input port's source, `MpegTsBusExecutor` re-points
     * the named `unixfdsrc` at the new edge socket (make-before-break) instead
     * of stop/starting the module — so the module's own producer sockets stay
     * up and the downstream graph never notices (the 2026-07-23 head-end
     * switch cascade). Return null (or omit) for ports whose pipeline SHAPE
     * depends on the source — those keep the classic restart.
     */
    getLiveInputSwap?(sinkPortId: string): { element: string } | null;
    /**
     * Target of the tracked `bus_reinput` RPC that executes a live input swap.
     * Defaults to the gst child process; a native (non-GStreamer) sink
     * overrides it with its own controller (ts-splitter →
     * `NativeSinkController`).
     */
    getLiveSwapTarget?(): LiveSwapTarget | null;
    /**
     * Re-derive and store the pipeline description after a live mutation the
     * running pipeline already absorbed (bus_reinput input swap), so
     * crash-restarts replay the CURRENT graph. Implemented by GstPluginBase;
     * returns false when there is nothing to refresh.
     */
    refreshPipelineDescription?(): Promise<boolean>;
    /** Set module health (implemented by the plugin bases; used by the
     *  routing layer for module-scoped conditions like a pending input swap). */
    setHealth?(health: 'ok' | 'warning' | 'error' | 'stopped', error?: string): void;
}

/**
 * Pipeline description returned by GstPluginBase.buildPipeline().
 * Phase 3 (gst-runner) will consume this to spawn GStreamer.
 */
export interface PipelineDescription {
    /** GStreamer pipeline string (for gst-launch style). */
    pipeline: string;
    /** When true, gst-runner pipes stdin/stdout for data (MPEG-TS) instead of bus messages. */
    useStdioForData?: boolean;
    /** When true, pipeline auto-restarts on GStreamer bus error or EOS (like v1 reload behaviour). */
    restartOnError?: boolean;
    /**
     * Backoff for the inner restart loop in gst-runner. Defaults to 1s → 5s,
     * which is fine for transient blips but pegs CPU when the failure is
     * durable (e.g. SRT caller mode with an unreachable remote re-spawns
     * Python every few seconds). Tune for the failure mode — SRT plugins
     * ship 5s → 10s (peer-down has no benefit from longer backoff: we don't
     * know when it returns, so retrying often is what feels snappy).
     */
    restartBackoffMs?: { baseMs?: number; maxMs?: number };
    /**
     * Rules for linking sometimes-pads (tsdemux, decodebin, …) to dynamically
     * created branches at runtime. Each rule listens for `pad-added` on a
     * named element in the pipeline and instantiates one fresh branch per
     * matched pad — capped by the length of `branches`. See `PadLinkRule`.
     */
    linkOnPadAdded?: PadLinkRule[];
    /**
     * When true, the runner attaches a `queue ! appsink` to every `meta/x-klv`
     * pad a `tsdemux` exposes, parses the payload off it, and reports the raw
     * bytes on the `stream:names` plugin-event channel (mpegts demuxer in-band
     * name channel, Phase 2). The mandatory `queue` is the Phase 0 finding — an
     * appsink straight on a tsdemux pad back-pressures the streaming loop and
     * stalls the whole TS. Off by default; only the demuxer sets it. Per plan
     * D6 the reader never affects routing or pipeline health.
     */
    readKlvNames?: boolean;
    /**
     * Extra environment variables for the Python runner that hosts this
     * pipeline. Merged into `spawn`'s env at fork time, so the values are
     * visible *before* any GStreamer / GLib init runs in the child —
     * required for things that have to be set pre-`Gst.init()`. The engine
     * honours one such hook directly: `MR_GLIB_PRGNAME`, if present, is
     * applied via `GLib.set_prgname` in the Python child before init. Any
     * other entries are plugin-defined and just get passed through. Per-
     * pipeline (not per-runner) so a fresh spawn for a different config
     * picks up a different value.
     */
    env?: Record<string, string>;
    /**
     * Shared net-clock for cross-pipeline A/V sync. When set, the runner slaves
     * this pipeline to the given clock so it presents on the same timeline as
     * its sibling pipelines (e.g. video-player ↔ audio-decoder fed from one
     * source), eliminating the drift two independent pipelines get from their
     * own clocks. Plugins don't build this themselves — they set
     * `clockSync: true` and `GstPluginBase` resolves it from the engine's clock
     * authority. Off by default → today's per-pipeline behaviour.
     */
    clock?: ClockConfig;
    /**
     * Opt into cross-pipeline sync: `GstPluginBase.onStart` resolves the shared
     * clock from the engine's clock authority and fills `clock` before handing
     * the description to the runner. Requires the pipeline's sinks to be
     * `sync=true` and the buffers to carry the shared source PTS (no
     * per-consumer re-anchoring) for the lock to hold.
     */
    clockSync?: boolean;
    /**
     * Run this pipeline under the time-sync contract (engine-wide, on by
     * default — see `EngineConfig.timeSyncContract`). The runner puts the
     * pipeline on a plain monotonic `GstSystemClock` and PINS the timeline —
     * `set_start_time(CLOCK_TIME_NONE)` + `set_base_time(0)` — so running-time
     * ≡ clock time and every pipeline on the box shares one time base without
     * any clock daemon to reach. Plugins don't set this themselves:
     * `GstPluginBase` stamps it on a `clockSync` description when the engine
     * runs the contract, INSTEAD of resolving a net clock. Never blocks
     * playback (there is nothing external to wait for).
     */
    timeSyncContract?: boolean;
    /**
     * Software (`avdec_*`) decoder threading mode for this pipeline.
     * `max-threads` is always the core count; this only controls ffmpeg's
     * `thread-type`:
     *   - `'auto'` (default / omitted): leave ffmpeg's choice — single-core on
     *     the live path, zero added latency.
     *   - `'frame'`: force frame-parallel decode across all cores — the mode
     *     that actually relieves a pinned core on heavy 4K software decode, at
     *     the cost of ~130-160 ms added latency (frames decoded ahead, then
     *     reordered). Opt-in only; never default on a live/low-latency path.
     * (Slice threading isn't offered — it gives no speedup on the single-slice
     * broadcast streams these boxes carry.) Ignored by a HW (VAAPI) decoder.
     */
    decoderThreadType?: 'auto' | 'frame';
    /**
     * Bus-message subscriptions: for each `{element, structure}`, the runner
     * forwards that element's matching ELEMENT bus messages to the module on the
     * generic `<structure>:<element>` plugin-event channel (payload = the
     * structure as an object) — see GstPluginBase.onPluginEvent. Any bus message
     * works (`level`, `spectrum`, QoS, element stats, …) with no runner change;
     * a subscribed `level` element is forwarded instead of feeding the aggregate
     * VU meter. E.g. the audio-dynamics ducker subscribes to its sidechain
     * `level` element and keys its gain envelope off `level:sclevel`.
     */
    busReports?: BusReport[];
    /**
     * librist half of a RIST module pipeline. When set, the runner drives
     * librist in-process (ctypes binding, `librist.py`): a `receiver` pushes
     * every RIST payload into the named appsrc; a `sender` drains the named
     * appsink into librist. This replaces the ristreceiver/ristsender CLI
     * relay and its loopback UDP hop, so RIST modules ride the normal bus
     * transport (tee fan-out under unixfd) like any other gst module. librist
     * stats arrive on the `rist:stats` plugin-event channel (same JSON shape
     * the CLI printed on stderr).
     */
    rist?: RistRunnerConfig;
    /**
     * Report-only video-info probe for a TS passthrough pipeline. The runner
     * watches the named appsink (a leaky tap off the egress tee), discovers
     * the FIRST video ES of the FIRST program and emits `tsprobe:videoinfo`
     * plugin events: `{pid, codec, width, height, interlaced, fps, scrambled,
     * display}` — `display` pre-formatted ("1920×1080i50"), geometry fields
     * null until the SPS parses (H.264/H.265 only; MPEG-1/2 report codec
     * only). Cheap by design: full scan until the first SPS, then 1-in-64
     * buffer sampling. Never affects routing.
     */
    tsProbe?: TsProbeRunnerConfig;
    /**
     * Report-only render keep-up watch. The runner reads the named sink's
     * GstBaseSink `stats` (rendered/dropped) per 2 s window and compares the
     * PRESENTED rate against the framerate the negotiated caps declare —
     * counting pad arrivals instead was a proven blind spot (a sink can
     * receive 50 fps and silently discard a third of it; observed on Pi 4
     * waylandsink, 2026-08-01). Pad arrivals still gate the judgement: a
     * window with no arrivals is the stall watchdog's condition, not lag,
     * and sinks without `stats` fall back to arrival counting. On lag it
     * emits `renderwatch:lag` `{achievedFps, expectedFps, droppedFps}`;
     * when the rate is back it emits `renderwatch:recovered`. Hysteresis
     * (0.85 trip / 0.95 recover, 3 consecutive windows) lives runner-side
     * in render_lag.py. Never affects routing.
     */
    renderWatch?: RenderWatchRunnerConfig;
    /**
     * Hold the named decoder shut until the first KEYFRAME of the stream.
     *
     * WHY. A live TS join lands mid-GOP: the first access units to reach the
     * decoder are delta units referencing frames it never saw. A stateless
     * V4L2 decoder (`v4l2slh265dec`/rpivid on Pi 4, `hevc_dec` on Pi 5, kernel
     * 6.12.87) does not merely produce garbage from that — it ends up holding a
     * decode request that never completes, and the next teardown blocks
     * forever in the kernel (`hevc_d_h265_stop` in D state with the videodev
     * mutex held). That freezes V4L2 box-wide and only a reboot clears it. The
     * EOS drain cannot help: it is the decoder, not the ordering, that is
     * already stuck.
     *
     * WHAT IT DOES. The runner puts a buffer probe on the named element's SINK
     * pad and DROPS every buffer flagged `GST_BUFFER_FLAG_DELTA_UNIT` until the
     * first buffer without it (`h264parse`/`h265parse` flag this per access
     * unit). That keyframe passes and the gate opens. Events (caps, segment)
     * are never touched.
     *
     * IT ALSO RE-ARMS. The probe stays on the pad and shuts again on a delta
     * unit flagged `GST_BUFFER_FLAG_DISCONT` — the mark a `leaky=2` queue
     * leaves when it has shed buffers, carried through the parser. Loss inside
     * the pipeline (the live chain's jitter queues shed under a decoder stall)
     * leaves the following delta units referencing frames the decoder never
     * saw, which is the SAME missing-reference hazard as a mid-GOP join and
     * wedges the same hardware. Steady-state cost is one flag test per access
     * unit.
     *
     * SCOPE: once per pipeline START, and armed for that pipeline's life. A
     * `restartOnError` replay is a fresh `start` and therefore a fresh gate.
     *
     * Only for chains that NAME their decoder — a `decodebin3` pipeline plugs
     * its decoder itself, so there is no element name to give here.
     */
    keyframeGate?: KeyframeGateConfig;
    /**
     * Carry the SOURCE PES timeline through the named `tsdemux` (2026-07-23
     * incident / TodoNotes:20). tsdemux erases the source timeline (buffer PTS
     * rebased ~0 per incarnation), so a transcoding pipeline's output mux
     * stamps a fresh timeline every (re)start and downstream muxers anchor its
     * A/V branches by arrival — restarts re-roll lipsync. When set, the runner
     * latches the first PES PTS per PID on the demux sink pad and shifts each
     * media src pad onto the source timeline via `GstPad.set_offset()`, so
     * output PES PTS/PCR carry source values and every restart re-derives the
     * SAME timeline. Scope: per-incarnation only — mid-stream source
     * discontinuities and the 26.5 h 33-bit PTS wrap are not followed.
     */
    preserveSourceTimeline?: PreserveSourceTimelineConfig;
}

/** Config for `PipelineDescription.preserveSourceTimeline`. */
export interface PreserveSourceTimelineConfig {
    /** `name=` of the tsdemux whose branches must carry the source timeline. */
    demux: string;
}

/** TS video-info probe config — see PipelineDescription.tsProbe. */
export interface TsProbeRunnerConfig {
    /** `name=` of the tap appsink in `pipeline` receiving the muxed TS. */
    appsink: string;
}

/** Render keep-up watch config — see PipelineDescription.renderWatch. */
export interface RenderWatchRunnerConfig {
    /** `name=` of the video sink element in `pipeline` to watch. */
    sink: string;
}

/** Keyframe gate config — see PipelineDescription.keyframeGate. */
export interface KeyframeGateConfig {
    /** `name=` of the decoder in `pipeline` whose sink pad is gated. */
    decoder: string;
}

/** librist runner config — see PipelineDescription.rist. */
export interface RistRunnerConfig {
    /** `receiver` feeds the named appsrc; `sender` drains the named appsink. */
    role: 'receiver' | 'sender';
    /** rist:// peer URLs; per-link params (weight, cname, …) stay in the URL. */
    urls: string[];
    /** RIST profile: 0 simple, 1 main (default), 2 advanced. */
    profile?: number;
    /** Recovery buffer in ms — folded into each URL as `buffer=`. */
    buffer?: number;
    /** Receiver flow session timeout in ms — folded in as `session-timeout=`.
     *  librist deletes a flow after this long with no data (default 2000 ms);
     *  on links with brief blackouts or restart-prone senders, ~10000 ms keeps
     *  the flow alive through the gap (brief freeze) instead of a
     *  delete/reconnect churn that cascades into downstream rebuilds. */
    sessionTimeout?: number;
    /** Encryption pre-shared secret — folded into each URL as `secret=`. */
    secret?: string;
    /** AES key size for `secret` (128 | 256) — folded in as `aes-type=`. */
    encType?: number;
    /** NULL-packet deletion (sender only). */
    npd?: boolean;
    /** librist stats interval in ms → `rist:stats` plugin events (0 disables). */
    statsInterval?: number;
    /** `name=` of the appsrc (receiver) / appsink (sender) in `pipeline`. */
    appElement: string;
}

/** A bus-message subscription — see PipelineDescription.busReports. */
export interface BusReport {
    /** `name=` of the element whose bus messages to forward. */
    element: string;
    /** Structure name to match (e.g. `level`, `spectrum`). Channel is `<structure>:<element>`. */
    structure: string;
}

/**
 * Where to reach the shared net clock for cross-pipeline A/V sync — the single
 * source of truth for this shape (the runner protocol + ClockAuthority import
 * it). No base-time: pipelines anchor naturally on the shared clock (same rate
 * ⇒ no drift, small constant start offset).
 */
export interface ClockConfig {
    host: string;
    port: number;
}

export interface PadLinkRule {
    /** Element name in the pipeline whose `pad-added` is observed. */
    from: string;
    /** Caps filter — only match pads whose first caps structure starts with `${media}/`. */
    media: 'video' | 'audio';
    /**
     * One parse_launch fragment per matched pad, in pad-added order. The Nth
     * matching pad is linked to `branches[N]`; pads beyond the list length
     * are ignored.
     */
    branches: string[];
    /**
     * Optional — name of an outer-pipeline element to request a sink pad on
     * after each branch is built. The branch's auto-ghosted src pad is
     * linked to this element's freshly-requested `sink_%d`. Used to bridge
     * dynamically-built branches into a named muxer.
     */
    linkTo?: string;
    /**
     * Optional — explicit request-pad name(s) to ask `linkTo` for instead of
     * the implicit `sink_%d`. The Nth matched pad requests
     * `requestedPadNames[N]`; if the list is shorter than the number of pads,
     * pads beyond it fall back to `sink_%d`. Generic by design — any element
     * whose request-pad template derives behaviour from the pad name can use
     * it. `mpegtsmux` is the first consumer: a `sink_<pid>` name pins that
     * stream's PID (plan D3 deterministic-PID scheme).
     */
    requestedPadNames?: string[];
    /**
     * Optional — match pads to branches by PID instead of pad-added order.
     * `branches[N]` is linked to the pad whose PID equals `matchPids[N]` (the
     * PID is read from the demux pad name `<media>_<prog>_<pidhex>`). A pad
     * whose PID isn't in the list is ignored. This fixes the positional
     * fragility of the default Nth-pad → Nth-branch contract: with stable
     * PID-based ports (mpegts-demuxer, plan Phase 3) a source can add or
     * reorder streams without misrouting. When absent, the positional
     * contract is used unchanged.
     */
    matchPids?: number[];
    /**
     * Optional — timestamp offset (ns) applied via `GstPad.set_offset()` on
     * the `linkTo` request pad before linking. Positive delays the stream on
     * the target's timeline; negative advances it (buffers whose shifted
     * running-time falls before the segment start are clipped — costs that
     * much stream at startup, nothing steady-state). Requires `linkTo`;
     * ignored on the `matchPids` tee-fanout path. First consumer: mpegts-muxer
     * per-audio-input lipsync offset (cancels a measured constant path skew).
     */
    padOffsetNs?: number;
}

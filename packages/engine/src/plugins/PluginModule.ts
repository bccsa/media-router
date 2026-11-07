import type { ModuleTimingSummary, PluginManifest, StreamType } from '@media-router/shared-types';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { BusAttachTarget, LiveSwapTarget } from '../child-process/UnixFdFanoutController.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';
import type { HouseClock } from '../clock/HouseClock.js';

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
    /** Display hint: the port is kept only because a stored connection
     *  still references it — its stream is absent from the live source
     *  (ts-splitter PID that left the PMT). Registered and connectable as
     *  normal; the UI may dim it. */
    stale?: boolean;
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
    /** The engine's house epoch E and time-sync state (house-clock design §4.2):
     *  `epoch()`, `ready()`, events `epoch` and `state`. Absent in test harnesses. */
    houseClock?: HouseClock;
}

/**
 * Optional static hooks a plugin class may expose. Both run once per plugin
 * class during load:
 * - `initManifest(manifest)` — probe the host for runtime capabilities and
 *   mutate the manifest before any module instances are created (used by
 *   video-encoder to detect available HW encoders, audio-encoder to detect
 *   supported codecs, etc.). One that a gst-inspect timeout cut short runs
 *   again before the plugin's next module start (`PluginLoader.settle`,
 *   B-102), so it must be safe to run twice and must let that error through.
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
    /**
     * Initialise with config and engine services. Called before the first start, and again before a
     * start with a setting change pending a restart (B-191): allocate nothing a second call leaks.
     */
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
     * Opt a MULTI-INPUT bus sink (an aggregator) into live input add/remove:
     * the engine mutates ONE named branch bin on the running pipeline instead
     * of stop/starting the module (plugins/README.md, "Live Input Branches").
     */
    getLiveInputBranch?(sinkPortId: string, connectionId: string): LiveInputBranch | null;
    /** A live input branch that was dropped (dead producer) is back. */
    noteLiveInputRestored?(branchName: string): void;
    /** A live add waits for its producer's edge socket: the pipeline runs without the branch
     *  until it joins (B-194). */
    noteLiveInputAbsent?(branchName: string): void;
    /** The pipeline runs without this live input branch: dropped (dead producer), or left out
     *  at launch (`liveInputs`). The engine adds it when its producer plays (B-192). */
    isLiveInputLost?(branchName: string): boolean;
    /**
     * Channel count of the audio stream this module emits on a bus OUTPUT
     * port, for producers whose width is a runtime choice. `MediaRouter`
     * hands it to consumers as `sourceChannels` (`getModuleBusSources`), which
     * size their channel-map matrices from it. Omit it (or return undefined)
     * when the width is fixed — consumers then apply their own default. It
     * describes the WIRE, never a config field: a producer configured for
     * N input channels that still encodes a fixed-width stream declares
     * nothing.
     */
    getBusStreamChannels?(portId: string): number | undefined;
    /** The lateness summary its `timing` section shows (§9.5; GstPluginBase). A consumer's
     *  aligner input starts its pace at this producer's output lateness (`seedLatenessMs` in
     *  `MediaRouter.getModuleBusSources`, WI-P2-13). */
    getTimingSummary?(): ModuleTimingSummary | undefined;
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

/** One live-addable input branch of an aggregator sink (`getLiveInputBranch`). */
export interface LiveInputBranch {
    /** The aggregator element the branch links into (request `sink_%u` pad). */
    element: string;
    /** Branch bin name — stable per connection, shared with `buildPipeline`. */
    name: string;
    /** gst-launch text ending in the element that links to the aggregator;
     *  absent on a remove (the connection is already gone). */
    description?: string;
}

/**
 * Pipeline description returned by GstPluginBase.buildPipeline().
 * Phase 3 (gst-runner) will consume this to spawn GStreamer.
 */
/** See `PipelineDescription.timingSink`. `video` sinks add one display refresh. */
export interface TimingSink {
    element: string;
    kind: 'audio' | 'video';
    /** Video: the output mode's refresh. Absent when unknown: 60 Hz stands in, and says so. */
    refreshHz?: number;
}

/** One input of a module's `timing` sections: the bus tap measuring it, its fixed number
 *  (`timing-in-<n>`) and its label (the module feeding it). */
export interface TimingInputRef {
    tap: string;
    n: number;
    label: string;
}

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
    /** EOS-drain before a deliberate stop (default true). The drain exists for
     *  stateless video decoders; a force-live audio aggregator never completes
     *  it, so audio-only bus producers set false. Never on a video decoder. */
    eosDrain?: boolean;
    /** Elements that hold this module's PipeWire stream (B-195): an error from one is a lost
     *  stream (`pipewire_lost`), which the runner does not restart; the module's device watchdog
     *  rebuilds it once PipeWire and the device are back. */
    pipeWireElements?: string[];
    /** Bin names of the live input branches in `pipeline` (filled by
     *  GstPluginBase from `getLiveInputBranch`). An error inside one drops
     *  that branch (`input_branch_lost`) instead of failing the pipeline. */
    liveInputBranches?: string[];
    /** An aggregator's input branches apart from `pipeline` (B-192, ADR-0010 rule 5): the runner
     *  launches with the ones whose sockets accept, the engine adds the others as their producers
     *  play. Name each in `getLiveInputBranch` too (the live verbs and the containment use it). */
    liveInputs?: LiveInputBranch[];
    /** A launch skips what its inputs deliver stamped before it first plays (B-206, native
     *  runner): the outage it was down for, never let into its mix; at its `render` element, what
     *  its mix queued meanwhile (B-167). See `CatchUpConfig`. */
    catchUp?: CatchUpConfig;
    /**
     * Rules for linking sometimes-pads (mrtsdemux, decodebin, …) to dynamically
     * created branches at runtime. Each rule listens for `pad-added` on a
     * named element in the pipeline and instantiates one fresh branch per
     * matched pad — capped by the length of `branches`. See `PadLinkRule`.
     */
    linkOnPadAdded?: PadLinkRule[];
    /**
     * When true, the runner attaches a `queue ! appsink` to every `meta/x-klv`
     * pad the demux exposes, parses the payload off it, and reports the raw
     * bytes on the `stream:names` plugin-event channel (mpegts demuxer in-band
     * name channel, Phase 2). The mandatory `queue` is the Phase 0 finding — an
     * appsink straight on a demux pad back-pressures the streaming loop and
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
     * udpsrc silence past this many ms errors the pipeline out (`udp_timeout`)
     * so the restart path re-joins the group — MULTICAST inputs only, where a
     * network blip can silently drop the IGMP membership. Unset/0 = silence is
     * only ever a health warning (`input_silent` / `input_resumed`); a listening
     * unicast socket needs nothing rebuilt. (#751 follow-up, 2026-09-15.)
     */
    udpSilenceRestartMs?: number;
    /**
     * Contract clock WITHOUT the timeline pinning: the runner still puts this
     * pipeline on the contract's monotonic house clock, but skips
     * `set_base_time(0)` / `set_start_time(CLOCK_TIME_NONE)` and lets base-time
     * anchor naturally at PLAYING. For pipelines whose head is a REAL LIVE
     * CAPTURE element feeding an aggregator-based muxer — today exactly
     * `v4l2src ! … ! mpegtsmux` (video-encoder).
     *
     * WHY. `mpegtsmux` is a GstAggregator (gst 1.28) and schedules its output
     * off RUNNING TIME. With base-time pinned to 0, running time equals house
     * time — a number the size of the box's uptime — while a live capture source
     * starts producing buffers at its own natural zero. The aggregator then
     * mis-schedules: it holds video and releases it in GOP-sized bursts. Measured
     * on a Pi4 + ATEM: egress alternates ~31 KB/s starve seconds with ~300 KB/s
     * spikes (~2.3 s period) instead of a flat rate, and every live consumer
     * freezes on one frame. Letting base-time anchor naturally puts the mux's
     * running time back next to the source's own timeline and the egress is flat.
     *
     * WHY THE CONTRACT STILL HOLDS. The producer stamp is base-time INDEPENDENT
     * by construction: the identity stamp maps to running time
     * `stamp − base_time` (`mrtsstamp`, `gst_mrtsstamp_clock_now`), and `unixfdsink` transmits
     * `segment_to_running_time(pts) + base_time`, so the base-time cancels and
     * the wire carries the same absolute house time either way. The clock half —
     * one fixed monotonic `GstSystemClock` per pipeline, shared by every process
     * on the box — is untouched. Consumers therefore see an identical timeline.
     *
     * SCOPE. It is a property of the PIPELINE, not of the plugin: bus-fed producers (transcoder,
     * mpegts-muxer) take their buffers from already-stamped bus input, not from a
     * live capture device, and MUST NOT set it — their demux's PES − 1 h is house
     * time only while running time is.
     *
     * Do not set this speculatively on other live-source modules. It is a
     * targeted fix for a measured aggregator mis-schedule; without the burst
     * pattern above (measure the egress rate), leave the pipeline on the pinned
     * timeline.
     */
    liveCaptureClock?: boolean;
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
     * LEGACY python RIST path (ADR-0013 keeps it as a fallback only). When
     * set, the runner drives librist in-process (ctypes binding,
     * `librist.py`): a `receiver` pushes every RIST payload into the named
     * appsrc; a `sender` drains the named appsink into librist; stats arrive
     * on the `rist:stats` plugin-event channel. The shipped RIST modules no
     * longer set this — they use the native `mrristsrc`/`mrristsink`
     * elements and `busReports` for `mrrist-stats`.
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
     * buffer sampling. Never affects routing. Every PMT change also emits
     * `tsprobe:pmt`: `{programNumber, pcrPid, streams: [{pid, streamType,
     * esInfo}]}` with each ES's raw descriptor loop as hex (the shape of the
     * splitter's `tssplit:discovered`) — descriptor-only facts a plugin
     * reads itself (e.g. teletext-subtitles → its detected-page list).
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
    /** The output's final (named) sink, read by the `timing` status section for presentation
     *  delay (`ts-offset`) and device latency (WI-P0-9). Engine-side, never sent to the runner. */
    timingSink?: TimingSink;
    /** Inputs whose bus taps are named per branch (`lat_busin_<i>`), which the router's edge
     *  list cannot map: their numbers and labels for the `timing` sections. Engine-side. */
    timingInputs?: TimingInputRef[];
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
     * Plugin-owned runner-side python (`plugins/<x>/py/<module>.py`, on the
     * runner's PYTHONPATH). For each entry the runner imports `module` and
     * calls `install(pipeline, config, ctx)` before PLAYING and `clear()` on
     * stop; `ctx` gives it `emit_event` and `emit_plugin_event`. The engine
     * never learns the domain (ADR-0002): subtitle-core's `subtitle_bridge`
     * is the first user, a plugin that needs per-buffer or dynamic-pad work
     * inside the runner is the next.
     */
    runnerHooks?: RunnerHook[];
    /**
     * Which runner process hosts this pipeline (ADR-0019). Unset: the native
     * `mr-gst-runner` whenever the description stays inside its feature set
     * (the default; `MR_GST_RUNNER_NATIVE=0` is the engine-wide rollback),
     * python otherwise. `'python'`
     * pins the python runner; `'native'` asks for the native one (logged and
     * downgraded to python when the description cannot run there).
     */
    runner?: 'python' | 'native';
}

export interface RunnerHook {
    /** Python module name (unique across plugins, like every plugin py module). */
    module: string;
    /** Passed to the module's `install` verbatim (JSON). */
    config?: unknown;
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
    /** `name=` of the `mrvideopace` before it: its rate drops count as frames kept up, both
     *  presented and arrived (a display slower than the content takes no more, B-169). */
    pace?: string;
}

/** Keyframe gate config — see PipelineDescription.keyframeGate. */
export interface KeyframeGateConfig {
    /** `name=` of the decoder in `pipeline` whose sink pad is gated. */
    decoder: string;
}

/** See PipelineDescription.catchUp. */
export interface CatchUpConfig {
    /** Name prefix of the elements whose SINK pad carries one input's content time into the
     *  mix (live branches added later included); the launch's first buffer there is its start. */
    prefix: string;
    /** The element whose SINK pad carries the output's content time where it first plays: there
     *  the launch also skips what queued before that first buffer, beyond its inputs' own lag
     *  (an absent input's wait, B-167). */
    render?: string;
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
     * ignored on the `matchPids` tee-fanout path. Generic runner support; no
     * plugin sets it today (the muxer's Audio Offset was removed 2026-09-28).
     */
    padOffsetNs?: number;
    /**
     * Optional — `'none'` skips the codec parser the runner injects in front of
     * each branch and, for H.264/H.265 pads, declares `alignment=au` instead
     * (the demux, `mrtsdemux`, emits one whole PES = one access unit per buffer
     * on this bus, ADR-0011). Saves one frame of latency per branch — the parser can
     * only close an AU when the next one starts — at the cost of the parser's
     * SPS/PPS re-emission before every IDR. Opt-in per module; the source must
     * repeat its parameter sets in-band. Default `'auto'`.
     */
    parser?: 'auto' | 'none';
}

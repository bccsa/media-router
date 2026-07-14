/**
 * Pure pipeline-assembly helpers for the MPEG-TS demuxer.
 *
 * The demuxer takes one inbound multi-program TS stream, demuxes it once with
 * a named `tsdemux`, and emits each elementary stream onto its own UDP
 * multicast group (one per configured output port). The actual pad → branch
 * fan-out is performed at runtime by the gst-pipeline-runner using the
 * `linkOnPadAdded` rules returned alongside the pipeline string.
 */

import {
    buildLeakyQueue,
    buildBackpressureQueue,
    buildUdpSink,
    buildUdpSrc,
    NET_UDP_RCV_BUF,
    type PadLinkRule,
} from '@media-router/engine';

export type PortDirection = 'input' | 'output';

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
    /**
     * Marks output ports whose downstream consumers must wait for this
     * pipeline to be PLAYING before they can be wired. Read by
     * `ConnectionApplier` to apply such connections first with a settle
     * delay (replaces the pre-extraction hardcoded `streamType === 'muxed/mpegts'`).
     */
    requiresOrderedApply?: boolean;
    /**
     * Display hint: the UI hides this port while no edge references it. The
     * port itself stays fully registered — visibility is decided client-side
     * where edge state is authoritative, never from the engine's connection
     * view (which is transiently empty at startup / ordered apply and would
     * orphan live edges if used to drop ports).
     */
    hideWhenUnconnected?: boolean;
}

const VIDEO_OUT_PREFIX = 'video-';
const AUDIO_OUT_PREFIX = 'audio-';
/** PID-based output port id prefix (plan Phase 3 — `pid-0x141`). */
const PID_OUT_PREFIX = 'pid-';
const INPUT_PORT_ID = 'mpegts-in';

export function videoPortId(index: number): string {
    return `${VIDEO_OUT_PREFIX}${index}`;
}
export function audioPortId(index: number): string {
    return `${AUDIO_OUT_PREFIX}${index}`;
}
export function inputPortId(): string {
    return INPUT_PORT_ID;
}

/**
 * PID-based output port id (plan Phase 3). The PID is the stable join key
 * (D3), so a port keyed by PID keeps its identity — and its downstream
 * connections — across restarts and label changes, unlike the positional
 * `video-N`/`audio-N` ids that shift when the stream order changes. Hex form
 * matches `StreamInspector.formatPid`.
 */
export function pidPortId(pid: number): string {
    return `${PID_OUT_PREFIX}0x${pid.toString(16)}`;
}

/** Parse a PID back out of a `pid-0x141` port id, or null if it isn't one. */
export function pidFromPortId(portId: string): number | null {
    if (!portId.startsWith(PID_OUT_PREFIX)) return null;
    const pid = Number.parseInt(portId.slice(PID_OUT_PREFIX.length), 16);
    return Number.isFinite(pid) ? pid : null;
}

/**
 * One persisted discovered stream (plan D5 — discovery populates config, never
 * replaces it). PID is the identity; `codec`/`name` are the last-known label
 * fallbacks so an offline port still renders something sensible before the
 * pipeline runs and the live inspector takes over.
 */
export interface DiscoveredStreamConfig {
    pid: number;
    media: 'video' | 'audio';
    codec?: string;
    name?: string;
}

/**
 * Read the persisted discovered-stream list from config. Only video/audio
 * entries with a numeric PID become ports — the metadata PID is never routed
 * (D6), and a malformed entry is skipped rather than crashing port resolution.
 */
export function discoveredStreams(config: Record<string, unknown>): DiscoveredStreamConfig[] {
    const arr = config.discoveredStreams;
    if (!Array.isArray(arr)) return [];
    const out: DiscoveredStreamConfig[] = [];
    for (const e of arr) {
        const r = e as { pid?: unknown; media?: unknown; codec?: unknown; name?: unknown } | null;
        if (!r || typeof r.pid !== 'number' || !Number.isFinite(r.pid)) continue;
        if (r.media !== 'video' && r.media !== 'audio') continue;
        out.push({
            pid: r.pid,
            media: r.media,
            ...(typeof r.codec === 'string' ? { codec: r.codec } : {}),
            ...(typeof r.name === 'string' ? { name: r.name } : {}),
        });
    }
    // Stable order: video PIDs first then audio, ascending — mirrors the
    // muxer's PID scheme and keeps the port list deterministic.
    return out.sort((a, b) => {
        if (a.media !== b.media) return a.media === 'video' ? -1 : 1;
        return a.pid - b.pid;
    });
}

/**
 * Label for a PID-based output port when offline (no live inspector data):
 * the persisted name, else `Video/Audio (codec, PID 0x141)` — the same shape
 * `StreamInspector.resolveLabel` generates, so a port reads the same whether
 * the source is live or dark.
 */
export function discoveredPortLabel(s: DiscoveredStreamConfig): string {
    if (s.name) return s.name;
    const media = s.media.charAt(0).toUpperCase() + s.media.slice(1);
    const pidHex = `0x${s.pid.toString(16)}`;
    return s.codec ? `${media} (${s.codec}, PID ${pidHex})` : `${media} (PID ${pidHex})`;
}

/**
 * Dynamic-port list. PID-based + legacy positional ports coexist (plan Phase 3
 * + migration, deliverable #3):
 *
 * - **PID-based** (`pid-0x141`) — one output per persisted `discoveredStreams`
 *   entry. Stable identity across restarts (D3); survives a source going dark
 *   (D5). These are the ports the pipeline actually routes once discovery has
 *   run, and the ones new connections should target.
 * - **Legacy positional** (`video-N`/`audio-N`) — emitted whenever the config
 *   still carries `videoStreamCount`/`audioStreamCount` (every deployed graph).
 *   Kept *alongside* the PID ports so an existing graph's connections (wired to
 *   `video-0` etc.) never dangle or error when discovery first populates the
 *   PID set — the migration that "cannot break existing connections". A config
 *   that never ran discovery has no `discoveredStreams`, so it sees exactly the
 *   legacy ports it always did, routed exactly as before.
 *
 * Keeping both (rather than a hard either/or swap that would orphan stored
 * `video-0` edges the instant discovery runs) is the choice that cannot break
 * connections: the operator re-points an edge from `video-0` to the matching
 * `pid-…` port at their convenience, with no lost-port error in between.
 * `legacyPortIdToPid` gives the UI/operator that ordinal→PID mapping.
 */
export function buildDynamicPorts(
    videoCount: number,
    audioCount: number,
    discovered: DiscoveredStreamConfig[] = [],
): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
    ];
    for (const s of discovered) {
        ports.push({
            id: pidPortId(s.pid),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: discoveredPortLabel(s),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    }
    // Once PID ports exist, legacy positional ports are display-noise unless
    // something is wired to them. They stay REGISTERED unconditionally — see
    // the `hideWhenUnconnected` doc on DynamicPort for why visibility is a
    // UI decision, not an engine one.
    const hideLegacy = discovered.length > 0;
    for (let i = 0; i < videoCount; i++) {
        ports.push({
            id: videoPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: `Video ${i + 1}`,
            maxConnections: -1,
            requiresOrderedApply: true,
            ...(hideLegacy ? { hideWhenUnconnected: true } : {}),
        });
    }
    for (let i = 0; i < audioCount; i++) {
        ports.push({
            id: audioPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: `Audio ${i + 1}`,
            maxConnections: -1,
            requiresOrderedApply: true,
            ...(hideLegacy ? { hideWhenUnconnected: true } : {}),
        });
    }
    return ports;
}

/**
 * Map a legacy positional output id (`video-0`, `audio-1`) onto the PID-based
 * id (`pid-0x141`) of the discovered stream at that ordinal, for the migration
 * that mustn't break existing connections (deliverable #3). The Nth video
 * positional id maps to the Nth discovered video stream (sorted by PID), same
 * for audio. Returns null when the id isn't a legacy positional id or there's
 * no discovered stream at that ordinal — caller leaves such edges untouched.
 *
 * Mirrors the muxer's D3 ordinal→PID pinning (video-N → 0x100+N), so a graph
 * built against the positional muxer/demuxer pair maps to the right PID. Used
 * by the demuxer to route a still-connected legacy port to its discovered
 * stream's pad, and exposed for an operator-facing "re-point to PID port" hint.
 */
export function legacyPortIdToPid(
    portId: string,
    discovered: DiscoveredStreamConfig[],
): string | null {
    const media: 'video' | 'audio' | null = portId.startsWith(VIDEO_OUT_PREFIX)
        ? 'video'
        : portId.startsWith(AUDIO_OUT_PREFIX)
          ? 'audio'
          : null;
    if (!media) return null;
    const idx = Number.parseInt(portId.slice(media.length + 1), 10);
    if (!Number.isInteger(idx) || idx < 0) return null;
    const ofMedia = discovered.filter((s) => s.media === media);
    const match = ofMedia[idx];
    return match ? pidPortId(match.pid) : null;
}

export interface DemuxerOutput {
    portId: string;
    host: string;
    port: number;
    /**
     * PID this output is pinned to (PID-based ports, plan Phase 3). When set,
     * the runner links the demux pad whose PID matches — fixing the long-
     * standing positional fragility where the Nth pad-added had to be the Nth
     * branch. Absent on legacy positional outputs, which keep the positional
     * contract.
     */
    pid?: number;
}

export interface DemuxerPipelineInputs {
    /** Upstream UDP source (from MediaRouter.getModuleUdpSource). */
    input: { host: string; port: number };
    videoOutputs: DemuxerOutput[];
    audioOutputs: DemuxerOutput[];
    /** Branch queue behaviour (defaults to false = non-leaky). Leaky sheds
     *  the oldest whole frame when the bound fills (live production: never
     *  hold backlog); non-leaky holds and back-pressures (contribution:
     *  never drop). The paced audio branch forces non-leaky ahead of
     *  clocksync regardless — a leaky queue there would shear every paced
     *  burst (measured). */
    queueLeaky?: boolean;
    /** Branch queue bound in ms (defaults to 400, clamped 20–5000). Leaky:
     *  how much backlog to tolerate before shedding. Non-leaky: the runaway
     *  safety cap. Paced audio uses max(this, audioPacingMs + 240). */
    queueDepthMs?: number;
    /** Pace demuxed audio to per-frame cadence via clocksync (defaults to
     *  true). OFF passes raw PES bursts through — the low-latency choice.
     *  See AUDIO_PACING_MS_DEFAULT. */
    audioPacing?: boolean;
    /** Pacing offset in ms (defaults to 160). Must cover one source PES —
     *  tune down for a smaller-PES source to shave egress delay, up for a
     *  bigger one. Only consumed while `audioPacing` is on. */
    audioPacingMs?: number;
    /** Output smoothing buffer in milliseconds (defaults to 0 = OFF). When 0
     *  the branch strings are byte-identical to the low-latency live path; when
     *  > 0 each branch prepends a deep non-leaky queue that absorbs a bursty
     *  source (e.g. HLS) instead of dropping mid-frame. See `buildOutputBranch`
     *  and the Phase 5 section of docs/mpegts-dynamic-streams-plan.md. */
    outputBufferMs?: number;
}

const DEMUX_NAME = 'demux';

/**
 * Default bound (ms) for the per-branch queue (operator-tunable via
 * `queueDepthMs`). Non-leaky (default): a runaway/memory safety cap, NOT a
 * latency budget — on the loopback path the udpsink always drains so the
 * queue sits near-empty (≈0 latency) and only back-pressures if a consumer
 * genuinely stalls. Leaky: the backlog tolerance before the oldest whole
 * frame is shed. Sized to cover the paced-audio worst case
 * (ts-offset 160 ms + one PES) so both media share one default.
 */
const BRANCH_QUEUE_MS_DEFAULT = 400;

/** Clamp the operator-set branch queue depth. */
export function clampQueueDepthMs(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : BRANCH_QUEUE_MS_DEFAULT;
    return Math.max(20, Math.min(5000, n));
}

/**
 * Audio branch pacing (measured on gate01, 2026-07-08). tsdemux only pushes an
 * audio PES once its LAST byte arrives, so a source that packs ~7 AAC frames
 * per PES (149 ms) emits the whole PES as one line-rate burst even though the
 * TS packets arrived smoothly (input: 3.7 ms cadence; output: 150 ms bursts,
 * 98% of datagrams <1 ms apart). Downstream consumers with a small jitter
 * budget (audio decoders, N×SRT links colliding) surface that as choppy audio
 * / wire loss. `clocksync` re-times each parsed frame to its PTS, restoring a
 * one-frame (21.3 ms @ 48 kHz AAC) cadence — verified live: p99 21.6 ms, zero
 * >100 ms gaps, full 453 kbps content.
 *
 * `ts-offset` must cover one PES worth of frames: every frame in the PES is
 * already PAST its PTS when the PES completes (that's why a bare sync=true
 * sink doesn't pace — everything renders as already-late). The default
 * 160 ms covers the common 100–150 ms ADTS packing; a source with even
 * bigger PES degrades gracefully to today's render-immediately behaviour.
 * Operator-tunable via `audioPacingMs` (a smaller-PES source can run a
 * smaller offset for less egress delay). This is NOT added buffering in the
 * latency-budget sense: the receiver already had to dejitter the full PES
 * quantum to play smoothly — the wait just moves to the sender where it
 * stops burst collisions. A/V sync is unaffected (PTS untouched; downstream
 * re-mux aligns by PTS).
 */
const AUDIO_PACING_MS_DEFAULT = 160;
const AUDIO_PACING_MS_MAX = 2000;

/**
 * Floor (ms) for the NON-leaky audio branch queue ahead of `clocksync`. The
 * queue is the thread boundary that keeps clocksync's clock-wait out of the
 * shared tsdemux streaming thread (blocking there would stall every sibling
 * branch), and it must hold at least ts-offset + one PES without dropping —
 * the old 50 ms leaky queue would shear the tail off every paced burst. The
 * actual bound scales with the configured offset:
 * `max(400, audioPacingMs + 240)` (240 ≈ one worst-case PES + margin), so
 * the default offset keeps the measured-good 400 ms bound exactly.
 */
const AUDIO_BRANCH_QUEUE_MIN_MS = 400;

/** Non-leaky audio branch queue bound for a given pacing offset. */
export function audioBranchQueueMs(pacingMs: number): number {
    return Math.max(AUDIO_BRANCH_QUEUE_MIN_MS, pacingMs + 240);
}

/** Clamp the operator-set pacing offset to a sane range. */
export function clampAudioPacingMs(value: unknown): number {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : AUDIO_PACING_MS_DEFAULT;
    return Math.max(0, Math.min(AUDIO_PACING_MS_MAX, n));
}

export interface DemuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
}

/** Per-output branch: a single-program TS muxer feeding a unique multicast port.
 *
 *  No codec parser in the JS string. The Python pad-link runner inspects each
 *  pad's caps at pad-added time and prepends the right parser (`h264parse`,
 *  `aacparse`, `ac3parse`, …) before parsing the branch. That keeps this
 *  pipeline codec-agnostic and means one demuxer can serve mixed-codec
 *  streams (e.g. one AAC pad + one Opus pad) without per-pad config.
 *
 *  Tail is `mpegtsmux ! udpsink` with no queue between them — see the inline
 *  comment in the function body for why a leaky queue at this boundary
 *  corrupts decode rather than helping.
 *
 *  `outputBufferMs` (default 0 = OFF) prepends a single deep NON-leaky queue
 *  ahead of the branch — opt-in burst smoothing for a bursty source (HLS). At
 *  0 the returned string is byte-identical to the low-latency live path, so
 *  SRT/RIST users get zero behaviour change. See the Phase 5 section of
 *  docs/mpegts-dynamic-streams-plan.md (spike-validated: non-leaky absorbs the
 *  burst instead of dropping mid-frame, and does not stall sibling branches off
 *  the shared tsdemux). */
export interface OutputBranchOptions {
    /** Opt-in burst smoothing ahead of the branch (0 = OFF). */
    outputBufferMs?: number;
    /** Pace audio to per-frame cadence via clocksync (default true). */
    audioPacing?: boolean;
    /** Pacing offset ms (default 160). See AUDIO_PACING_MS_DEFAULT. */
    audioPacingMs?: number;
    /** Shed-oldest (leaky) vs hold-and-back-pressure branch queue. Ignored
     *  (forced non-leaky) on the paced audio branch — see body. */
    queueLeaky?: boolean;
    /** Branch queue bound ms (default 400). */
    queueDepthMs?: number;
}

export function buildOutputBranch(
    out: DemuxerOutput,
    suffix: string,
    media: 'video' | 'audio',
    opts: OutputBranchOptions = {},
): string {
    const outputBufferMs = opts.outputBufferMs ?? 0;
    const audioPacing = opts.audioPacing ?? true;
    const queueLeaky = opts.queueLeaky ?? false;
    const depthMs = clampQueueDepthMs(opts.queueDepthMs);
    // The operator's stability-vs-latency call: non-leaky (default) holds and
    // back-pressures into the udpsrc socket buffer — the re-mux stays
    // lossless and, with the always-draining loopback udpsink, the queue sits
    // near-empty (≈0 latency; the old always-leaky video queue shed frames
    // the wire never lost, surfacing as macroblocking). Leaky sheds the
    // oldest whole frame once the bound fills — live production's "never
    // hold backlog" choice. Placed AFTER the (runner-injected) parser in
    // every variant so drops/back-pressure land on whole access units, not
    // mid-NAL.
    const branchQueue = queueLeaky ? buildLeakyQueue(depthMs) : buildBackpressureQueue(depthMs);
    // `async=false` is load-bearing: this branch is parsed and `add()`ed to an
    // ALREADY-PLAYING pipeline at pad-added time, then `sync_state_with_parent`.
    // A default (async) udpsink would hold its first buffer in preroll, stalling
    // the shared tsdemux pad and freezing EVERY branch — the pipeline reaches
    // PLAYING but pumps nothing (input socket backs up, all outputs stay silent).
    const sink = buildUdpSink({ name: `usink_${suffix}`, host: out.host, port: out.port, async: false });
    // No queue between mpegtsmux and udpsink — EVER, in any mode: mux output
    // buffers are untimestamped mid-frame TS chunks (~1316 B = 7 TS packets),
    // so a leaky drop there corrupts decode at the receiver and a time-bound
    // queue cannot even measure its depth. The kernel UDP send buffer absorbs
    // typical bursts on its own. The per-branch queue above is the ONLY
    // policy point.
    // alignment=-1 (auto) on every branch: let mpegtsmux emit its natural
    // buffer grouping instead of pinning a fixed packets-per-datagram count
    // (7 batched video into MTU-sized sends, 1 forced per-packet audio).
    let branch: string;
    if (media === 'video') {
        branch = `${branchQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=-1 ! ${sink}`;
    } else if (audioPacing) {
        // Non-leaky queue first (thread boundary + PES-burst absorber — see
        // audioBranchQueueMs), then clocksync re-times the parsed frames to
        // their PTS (see AUDIO_PACING_MS_DEFAULT) BEFORE the muxer: mpegtsmux
        // emits untimestamped output buffers, so pacing after it (a sync'd
        // udpsink) has nothing to sync against — measured no-op. The queue is
        // FORCED non-leaky regardless of `queueLeaky`: clocksync back-
        // pressures it by design while pacing a PES out, so a leaky queue
        // here would shear the tail off every burst.
        const pacingMs = clampAudioPacingMs(opts.audioPacingMs);
        const audioQueue = buildBackpressureQueue(Math.max(depthMs, audioBranchQueueMs(pacingMs)));
        const pacer = `clocksync sync=true ts-offset=${pacingMs * 1_000_000}`;
        branch = `${audioQueue} ! ${pacer} ! mpegtsmux name=mux_${suffix} latency=0 alignment=-1 ! ${sink}`;
    } else {
        // audioPacing OFF: raw PES bursts pass straight through — the
        // low-latency choice. Queue behaviour follows queueLeaky/queueDepthMs
        // like the video branch.
        branch = `${branchQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=-1 ! ${sink}`;
    }
    if (outputBufferMs <= 0) return branch;
    return `${buildSmoothingQueue(outputBufferMs)} ! ${branch}`;
}

/**
 * Opt-in output smoothing: a deep NON-leaky queue (`leaky=0` = BLOCK-not-drop)
 * holding up to `outputBufferMs` of buffers ahead of an output branch. Absorbs
 * a bursty source (HLS segment-boundary micro-bursts) and re-feeds the branch
 * steadily instead of the small per-branch leaky queue dropping mid-frame.
 *
 * Deliberately NOT `buildLeakyQueue` (that's `leaky=2` — it would still drop,
 * defeating the point) and NOT `tsparse`/`sync=true` (would re-anchor PCR or
 * depend on clustered timestamps — see Phase 5 candidates in the plan). Sized
 * to the window the burst fits, so the shared tsdemux is never back-pressured
 * past the window and sibling branches don't stall.
 */
function buildSmoothingQueue(outputBufferMs: number): string {
    const clamped = Math.max(0, Math.min(5000, outputBufferMs));
    const ns = clamped * 1_000_000;
    return `queue leaky=0 max-size-time=${ns} max-size-buffers=0 max-size-bytes=0`;
}

/**
 * Assemble the demuxer pipeline. Returns null when there is no upstream input
 * connection — caller should set a health warning.
 *
 * Pipeline shape:
 *   udpsrc ! tsdemux name=demux
 * No `tsparse` between `udpsrc` and `tsdemux` — see the inline comment for
 * why mid-pipeline PCR re-anchoring causes visible packet loss when the
 * stream is re-muxed downstream. The runner then attaches `linkOnPadAdded`
 * rules so each video/audio pad gets its own pre-built branch at runtime
 * (video: parser → queue → mpegtsmux → udpsink; audio: queue → clocksync →
 * mpegtsmux → udpsink).
 */
export function buildPipeline(input: DemuxerPipelineInputs): DemuxerPipelineResult | null {
    const outputBufferMs = input.outputBufferMs ?? 0;
    // Goes straight `udpsrc ! tsdemux` with no `tsparse` in between: re-deriving
    // PTS from PCR mid-pipeline rewrites buffer running-times onto a separate
    // timeline, and downstream `mpegtsmux latency=0` re-emitting PCR from those
    // values surfaces at the receiver as visible packet loss on live video.
    // No udpsrc `timeout` here (unlike the multi-source mpegts-muxer, where the
    // aggregator can't tell a late pad from a dead one). The demuxer has a single
    // loopback-bus input feeding independent output pads, so a silent input just
    // produces nothing — there's no aggregator to freeze. A timeout→restart can't
    // recover a loopback source anyway (the producer is a local pipeline; the
    // group never "goes away"); it only thrashes. At boot, before the upstream
    // ip-input has data, the old 5 s timeout restart-stormed the whole
    // demuxer→decoder chain and kept every port stuck showing "stale" for
    // minutes. The already-joined udpsrc receives the instant the local producer
    // starts, and a producer *port* change is handled by MpegTsUdpExecutor
    // restarting this module explicitly — not by a udpsrc watchdog.
    // NO caps declared at all (testing): negotiation falls to the
    // udpsrc↔tsdemux pad intersection, and the packetizer auto-detects the
    // packet size (188/192/204) from sync-byte spacing.
    const udpsrc = buildUdpSrc({
        host: input.input.host,
        port: input.input.port,
        bufferSize: NET_UDP_RCV_BUF,
    });
    const pipeline = `${udpsrc} ! tsdemux latency=0 name=${DEMUX_NAME}`;

    const branchOpts: OutputBranchOptions = {
        outputBufferMs,
        audioPacing: input.audioPacing ?? true,
        audioPacingMs: clampAudioPacingMs(input.audioPacingMs),
        queueLeaky: input.queueLeaky ?? false,
        queueDepthMs: clampQueueDepthMs(input.queueDepthMs),
    };
    const linkOnPadAdded: PadLinkRule[] = [];
    pushMediaRule(linkOnPadAdded, 'video', input.videoOutputs, 'v', branchOpts);
    pushMediaRule(linkOnPadAdded, 'audio', input.audioOutputs, 'a', branchOpts);

    return { pipeline, linkOnPadAdded };
}

/**
 * Append one per-media pad-link rule.
 *
 * - If **any** output carries a PID, route the whole media by PID: emit
 *   `matchPids` so the runner links each demux pad to the branch(es) for *its*
 *   PID. Robust to pad-add order and to extra source streams that aren't wired
 *   to an output. A PID may appear twice (a `pid-…` port and the legacy port
 *   that maps to it) — the runner fans the pad out via a tee. Outputs without
 *   a PID (an unmapped legacy port — no discovered stream for it) get no
 *   branch: they're stale ports, correctly silent rather than misrouted.
 * - If **no** output has a PID (pre-discovery legacy state), omit `matchPids`
 *   and keep the positional Nth-pad → Nth-branch contract unchanged.
 */
function pushMediaRule(
    rules: PadLinkRule[],
    media: 'video' | 'audio',
    outputs: DemuxerOutput[],
    suffixPrefix: string,
    opts: OutputBranchOptions,
): void {
    if (outputs.length === 0) return;
    const anyPinned = outputs.some((o) => typeof o.pid === 'number');
    if (!anyPinned) {
        rules.push({
            from: DEMUX_NAME,
            media,
            branches: outputs.map((o, i) =>
                buildOutputBranch(o, `${suffixPrefix}${i}`, media, opts),
            ),
        });
        return;
    }
    // PID-based routing: only pinned outputs get a branch (+ matching PID).
    const pinned = outputs.filter((o) => typeof o.pid === 'number');
    if (pinned.length === 0) return;
    rules.push({
        from: DEMUX_NAME,
        media,
        branches: pinned.map((o, i) =>
            buildOutputBranch(o, `${suffixPrefix}${i}`, media, opts),
        ),
        matchPids: pinned.map((o) => o.pid as number),
    });
}

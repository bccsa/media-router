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
    DEFAULT_MPEGTS_ALIGNMENT,
    buildLeakyQueue,
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
    /** Per-pad queue size in milliseconds (defaults to 50). Lower = lower
     *  latency, higher = more jitter tolerance. */
    bufferMs?: number;
    /** Output smoothing buffer in milliseconds (defaults to 0 = OFF). When 0
     *  the branch strings are byte-identical to the low-latency live path; when
     *  > 0 each branch prepends a deep non-leaky queue that absorbs a bursty
     *  source (e.g. HLS) instead of dropping mid-frame. See `buildOutputBranch`
     *  and the Phase 5 section of docs/mpegts-dynamic-streams-plan.md. */
    outputBufferMs?: number;
}

const DEMUX_NAME = 'demux';

/**
 * udpsrc timeout (5 s, in ns). A silent upstream — the muxer/encoder dark, or
 * the multicast group never producing — otherwise leaves tsdemux waiting
 * forever with no bus error to trigger `restartOnError`. The runner turns the
 * resulting `GstUDPSrcTimeout` element message into an error event, so a dark
 * source recovers via the normal restart path.
 */
const UDP_INPUT_TIMEOUT_NS = 5_000_000_000;

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
export function buildOutputBranch(
    out: DemuxerOutput,
    suffix: string,
    media: 'video' | 'audio',
    bufferMs: number,
    outputBufferMs = 0,
): string {
    const sink = buildUdpSink({ name: `usink_${suffix}`, host: out.host, port: out.port });
    // No leaky queue between mpegtsmux and udpsink: any drop here is a
    // mid-stream UDP buffer (~1316 B = 7 TS packets, part of a frame's
    // payload) and corrupts decode at the receiver. The kernel UDP send
    // buffer absorbs typical bursts on its own.
    let branch: string;
    if (media === 'video') {
        // Video queue placed AFTER the (runner-injected) parser so drops land
        // on whole access units, not mid-NAL — losing a sub-frame buffer
        // corrupts the AU and surfaces as packet loss until the next IDR.
        // `leaky=2 max-size-buffers=2` keeps latency to ≤2 frames and drops
        // a single complete frame under stall, which the decoder conceals.
        const videoQueue = `queue leaky=2 max-size-buffers=2 max-size-time=0 max-size-bytes=0`;
        branch = `${videoQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=${DEFAULT_MPEGTS_ALIGNMENT} ! ${sink}`;
    } else {
        // Audio queue after the (runner-injected) parser: drops land on whole
        // frames rather than half-frames, which keeps the muxer's caps stable.
        const audioQueue = buildLeakyQueue(bufferMs);
        // Audio-only output: alignment=1 (one TS packet per UDP datagram)
        // rather than 7. Packing 7 packets means waiting for ~40–160 ms of
        // audio to accumulate before each UDP send, which arrives at the
        // downstream decoder as bursts that exceed its late-tolerance budget
        // and surface as scratchy / dropped frames. Per-packet emission costs
        // ~7× UDP overhead but keeps timing smooth — on localhost / LAN the
        // bandwidth hit is irrelevant.
        branch = `${audioQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=1 ! ${sink}`;
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
 * (video: parser → queue → mpegtsmux → udpsink; audio: queue → mpegtsmux →
 * udpsink).
 */
export function buildPipeline(input: DemuxerPipelineInputs): DemuxerPipelineResult | null {
    const bufferMs = input.bufferMs ?? 50;
    const outputBufferMs = input.outputBufferMs ?? 0;
    // Goes straight `udpsrc ! tsdemux` with no `tsparse` in between: re-deriving
    // PTS from PCR mid-pipeline rewrites buffer running-times onto a separate
    // timeline, and downstream `mpegtsmux latency=0` re-emitting PCR from those
    // values surfaces at the receiver as visible packet loss on live video.
    const udpsrc = buildUdpSrc({
        host: input.input.host,
        port: input.input.port,
        caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
        timeoutNs: UDP_INPUT_TIMEOUT_NS,
        bufferSize: NET_UDP_RCV_BUF,
    });
    const pipeline = `${udpsrc} ! tsdemux latency=0 name=${DEMUX_NAME}`;

    const linkOnPadAdded: PadLinkRule[] = [];
    pushMediaRule(linkOnPadAdded, 'video', input.videoOutputs, 'v', bufferMs, outputBufferMs);
    pushMediaRule(linkOnPadAdded, 'audio', input.audioOutputs, 'a', bufferMs, outputBufferMs);

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
    bufferMs: number,
    outputBufferMs: number,
): void {
    if (outputs.length === 0) return;
    const anyPinned = outputs.some((o) => typeof o.pid === 'number');
    if (!anyPinned) {
        rules.push({
            from: DEMUX_NAME,
            media,
            branches: outputs.map((o, i) =>
                buildOutputBranch(o, `${suffixPrefix}${i}`, media, bufferMs, outputBufferMs),
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
            buildOutputBranch(o, `${suffixPrefix}${i}`, media, bufferMs, outputBufferMs),
        ),
        matchPids: pinned.map((o) => o.pid as number),
    });
}

/**
 * Pure pipeline-assembly helpers for the MPEG-TS muxer.
 *
 * Kept free of GStreamer / engine imports so they can be unit-tested with
 * plain inputs.
 */

import {
    TS_METADATA_PID,
    audioStreamPid,
    buildBackpressureQueue,
    buildLeakyQueue,
    buildUdpSink,
    buildUdpSrc,
    muxSinkPadName,
    NET_UDP_RCV_BUF,
    videoStreamPid,
    type PadLinkRule,
} from '@media-router/engine';
import type { NamedStreamInput } from './klvPayload.js';

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
}

export interface UdpInputSource {
    /** Sink port id this connection arrives on (e.g. "video-0", "audio-2"). */
    sinkPortId: string;
    host: string;
    port: number;
    /** Operator-set name for this input (live-updatable). Blank → fall back. */
    name?: string | null;
    /** Connected source module id (D4 name fallback when no operator name). */
    sourceModuleId?: string | null;
}

const VIDEO_PORT_PREFIX = 'video-';
const AUDIO_PORT_PREFIX = 'audio-';
const OUTPUT_PORT_ID = 'mpegts-out';

/** Element name of the metadata `appsrc` the runner pushes the KLV carousel
 *  onto (plan D2/Phase 2). The module references this when wiring live name
 *  updates to the `set_klv_payload` runner command. */
export const KLV_APPSRC_NAME = 'klvsrc';

/**
 * udpsrc timeout (5 s, in ns). A silent input — encoder dead, multicast
 * group never joined — is otherwise invisible: udpsrc posts no bus error, so
 * the muxer's aggregator quietly stalls its output with no signal to trigger
 * `restartOnError`. The runner turns the resulting `GstUDPSrcTimeout` element
 * message into an error event, so this makes a dark source recover via the
 * normal restart path instead of hanging until manually restarted.
 */
const UDP_INPUT_TIMEOUT_NS = 5_000_000_000;

/**
 * Default bound (ms) on each per-pad NON-leaky input queue (`queueLeaky`
 * off, the default). Must exceed the worst legitimate inter-stream skew the
 * aggregator waits out (audio transcode chain ~200 ms, demuxer audio pacing
 * 160 ms, B-frame DTS delay ~120 ms — measured on gate01); 500 ms covers all
 * with margin. This is a runaway safety cap, not a latency budget:
 * steady-state occupancy equals the skew, and the cap only bites when a
 * sibling input genuinely stalls — where the udpsrc timeout (above) is the
 * actual recovery. Operator-tunable via `queueDepthMs`.
 */
const MUX_INPUT_QUEUE_MS = 500;

/**
 * Per-use-case input queue behaviour (operator-selected via `queueLeaky`):
 *
 * - non-leaky (default) — zero frame shedding: the leading stream is held
 *   for up to `queueDepthMs` while the aggregator waits out inter-stream
 *   skew or a transient stall. Measured on gate01: leaky queues shed 11% of
 *   audio frames under a ~200 ms skew; non-leaky lost zero. Steady-state
 *   latency is identical (the mux is paced by the laggier input either way)
 *   — the difference is behaviour under degradation, where backlog is held
 *   and flushed rather than dropped.
 * - leaky — sheds the oldest whole frame once `queueDepthMs` of backlog has
 *   built up. For live production where a stalling sibling input must never
 *   queue up backlog: output resumes at the live edge immediately after
 *   recovery, at the cost of dropped frames whenever skew exceeds the bound.
 */

/** One configured input stream: just its operator-set name (blank = unset). */
export interface StreamEntry {
    name: string;
}

const MAX_STREAMS: Record<'video' | 'audio', number> = { video: 8, audio: 16 };

/**
 * Read the per-media stream list from config. Current shape: `videoStreams` /
 * `audioStreams` arrays of `{ name }` — one entry per input port, length is
 * the port count ("+ Add" in the UI appends an entry). Legacy shape (counts +
 * a `streamNames` map keyed by port id) is still honoured so deployed configs
 * keep their ports and labels until next edited.
 */
export function streamEntries(
    config: Record<string, unknown>,
    media: 'video' | 'audio',
): StreamEntry[] {
    const arr = config[media === 'video' ? 'videoStreams' : 'audioStreams'];
    if (Array.isArray(arr)) {
        return arr.slice(0, MAX_STREAMS[media]).map((e) => ({
            name:
                typeof (e as { name?: unknown } | null)?.name === 'string'
                    ? ((e as { name: string }).name)
                    : '',
        }));
    }
    const count = Math.max(
        0,
        (config[media === 'video' ? 'videoStreamCount' : 'audioStreamCount'] as number) ?? 1,
    );
    const legacyNames = (config.streamNames as Record<string, string> | undefined) ?? {};
    return Array.from({ length: Math.min(count, MAX_STREAMS[media]) }, (_, i) => ({
        name: legacyNames[`${media}-${i}`] ?? '',
    }));
}

export function videoPortId(index: number): string {
    return `${VIDEO_PORT_PREFIX}${index}`;
}
export function audioPortId(index: number): string {
    return `${AUDIO_PORT_PREFIX}${index}`;
}

export function isVideoInputPort(portId: string): boolean {
    return portId.startsWith(VIDEO_PORT_PREFIX);
}
export function isAudioInputPort(portId: string): boolean {
    return portId.startsWith(AUDIO_PORT_PREFIX);
}

/**
 * Build the dynamic port list that mirrors the configured stream counts.
 * The output port is always present so downstream players can connect even
 * when no inputs are configured yet.
 */
export function buildDynamicPorts(videoCount: number, audioCount: number): DynamicPort[] {
    const ports: DynamicPort[] = [];
    for (let i = 0; i < videoCount; i++) {
        ports.push({
            id: videoPortId(i),
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: `Video ${i + 1}`,
            maxConnections: 1,
        });
    }
    for (let i = 0; i < audioCount; i++) {
        ports.push({
            id: audioPortId(i),
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: `Audio ${i + 1}`,
            maxConnections: 1,
        });
    }
    ports.push({
        id: OUTPUT_PORT_ID,
        direction: 'output',
        streamType: 'muxed/mpegts',
        label: 'MPEG-TS Out',
        maxConnections: -1,
        requiresOrderedApply: true,
    });
    return ports;
}

/**
 * Build a single demux branch for one connected input. The branch ends at
 * `tsdemux name=demux_${branchId}` — its dynamic pads are bridged to
 * `mpegtsmux name=mux` at runtime by the per-media `linkOnPadAdded` rules
 * returned alongside the pipeline (see `buildPipeline`).
 *
 * Goes straight `udpsrc ! tsdemux` with no `tsparse` in between: re-deriving
 * PTS from PCR mid-pipeline rewrites buffer running-times onto a separate
 * timeline, and `mpegtsmux latency=0` re-emitting PCR from those values
 * surfaces at the receiver as visible packet loss on live video. The runner-
 * injected parser + the per-pad input queue downstream provide the only
 * buffering this branch needs.
 */
export function buildInputBranch(branchId: string, source: UdpInputSource): string {
    // No caps declared on udpsrc (matches the demuxer): negotiation falls to
    // the udpsrc↔tsdemux pad intersection, and the packetizer auto-detects the
    // packet size (188/192/204) from sync-byte spacing — verified end-to-end
    // on a capsless `udpsrc ! tsdemux` loopback run.
    const udpsrc = buildUdpSrc({
        host: source.host,
        port: source.port,
        timeoutNs: UDP_INPUT_TIMEOUT_NS,
        bufferSize: NET_UDP_RCV_BUF,
    });
    // The udpsrc `timeout` is load-bearing on a MULTI-source mux, not just a
    // nicety: `mpegtsmux` aggregates all its sink pads and CANNOT distinguish a
    // late pad from a dead one, so when any single input goes dark it stalls
    // the WHOLE combined output indefinitely (spike: `multi_source_dark_input.py`
    // — 1 output buffer in the 6.5 s after one of two inputs was killed). With
    // no timeout that stall is silent and unrecoverable. The timeout turns it
    // into a `GstUDPSrcTimeout` → runner error → `restartOnError` rebuild, which
    // is the only available recovery: the healthy inputs are already frozen by
    // the stall, so the restart disrupts nothing that was still flowing. The
    // restart does loop while a source stays permanently dark — making the mux
    // survive a dead input without a rebuild needs per-pad keepalive/fallback
    // (a real feature, not a tuning knob), since mpegtsmux has no drop-dead-pad
    // mode. `tsdemux latency=0` removes its default 700 ms input buffer — the
    // per-pad leaky queue downstream provides flow control.
    return `${udpsrc} ! tsdemux latency=0 name=demux_${branchId}`;
}

export interface MuxerPipelineInputs {
    sources: UdpInputSource[];
    output: { host: string; port: number };
    alignment: number;
    /** Input queue behaviour (defaults to false = non-leaky). See the
     *  queueLeaky doc above MUX_INPUT_QUEUE_MS. */
    queueLeaky?: boolean;
    /** Queue bound in ms (defaults to MUX_INPUT_QUEUE_MS, clamped 100–5000).
     *  Non-leaky: set to at least the worst inter-stream skew of the wiring
     *  (transcode chain, pacing offset, B-frame delay). Leaky: the backlog
     *  tolerance before shedding starts. */
    queueDepthMs?: number;
}

export interface MuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
    /** Per-stream identity for the in-band name carousel (plan D2/Phase 2),
     *  PID-keyed and in the same per-media ordinal order used for PID pinning.
     *  The module turns this into the KLV payload pushed to the runner. */
    namedStreams: NamedStreamInput[];
}

/**
 * Assemble the full pipeline + per-media pad-link rules.
 *
 * For each input, we expose a named `tsdemux` and emit one `linkOnPadAdded`
 * rule per media type. The branch itself is a parser-free `queue` — the
 * Python pad-link runner inspects each pad's caps at pad-added time and
 * prepends the matching parser (see `_parser_for_caps` in
 * `gst-pipeline-runner.py`), then links the bin's src into the named
 * muxer's request sink pad. Auto-detect by caps means one demuxer can
 * serve mixed-codec streams (e.g. one AAC + one Opus audio pad) without
 * per-pad config.
 *
 * Returns null when no inputs are wired — the caller should set a health
 * warning rather than start an empty pipeline.
 */
export function buildPipeline(input: MuxerPipelineInputs): MuxerPipelineResult | null {
    if (input.sources.length === 0) return null;
    // Per-pad input queue shape is the operator's stability-vs-latency call —
    // see the queueLeaky doc above MUX_INPUT_QUEUE_MS for the two behaviours
    // and the gate01 measurements (leaky queues shed 11% of audio under a
    // ~200 ms inter-stream skew, because mpegtsmux back-pressures the LEADING
    // pad by the skew on every buffer; non-leaky lost zero). The queue sits
    // AFTER the runner-injected parser so back-pressure/drops land on whole
    // access units, not mid-NAL. Dead-input recovery is mode-independent: a
    // dark source's own udpsrc timeout (above) is poll-based and fires
    // regardless of downstream back-pressure.
    const depth = Math.max(100, Math.min(5000, input.queueDepthMs ?? MUX_INPUT_QUEUE_MS));
    const inputQueue = (input.queueLeaky ?? false)
        ? buildLeakyQueue(depth)
        : buildBackpressureQueue(depth);
    const branches = input.sources.map((s, i) => buildInputBranch(String(i), s));
    const muxer = `mpegtsmux name=mux latency=0 alignment=${input.alignment}`;
    const sink = buildUdpSink({ name: 'usink', host: input.output.host, port: input.output.port });
    // No leaky queue between mpegtsmux and udpsink: any drop here is a
    // mid-stream UDP buffer (~1316 B = 7 TS packets, part of a frame's
    // payload) and corrupts decode at the receiver. The 2 MB kernel UDP
    // send buffer (≈4 s @ 4 Mbps) absorbs typical bursts on its own.
    //
    // In-band name channel (plan D2/Phase 2): a metadata `appsrc` pinned to the
    // fixed metadata PID feeds `mpegtsmux`. The runner pushes the KLV name
    // carousel onto `${KLV_APPSRC_NAME}` on a ~50 ms timer (and re-pushes on every
    // live name edit). Per D6 this branch never affects routing or pipeline
    // health: it's a static element that simply carries labels, and the demuxer
    // treats its absence as a non-event. `do-timestamp=true` lets mpegtsmux
    // schedule the packets without the pusher computing PTS.
    const klvSrc =
        `appsrc name=${KLV_APPSRC_NAME} caps=meta/x-klv,parsed=true ` +
        `format=time is-live=true do-timestamp=true ! mux.${muxSinkPadName(TS_METADATA_PID)}`;
    const pipeline = `${muxer} ! ${sink} ${branches.join(' ')} ${klvSrc}`;

    // Per-source pad-link rules: each tsdemux gets one rule per media type.
    // No codec parser in the branch — the Python pad-link runner injects the
    // matching parser at pad-added time from the actual pad caps, which
    // means upstream codec changes (or audio-only sources signalling video
    // by mistake) don't take this plugin's pipeline-build path down.
    // PID pinning (plan D3): each muxer input gets a deterministic PID via the
    // `mpegtsmux` request-pad name `sink_<pid>`. video-N → 0x100+N,
    // audio-N → 0x140+N, where N is the 0-based ordinal *within* that media
    // type — counted here in source-sort order so the same wiring always maps
    // to the same PIDs across restarts. The demuxer on the far end then keeps
    // stable port identity, and the PID is the join key for in-band naming
    // (Phase 2). Without this, mpegtsmux auto-numbers PIDs and they drift.
    const linkOnPadAdded: PadLinkRule[] = [];
    // Same per-media ordinal walk as the PID pinning above, recording each
    // stream's pinned PID + identity so the module can build the name carousel
    // (plan D2/D4). PID is the join key the demuxer matches names against.
    const namedStreams: NamedStreamInput[] = [];
    let videoOrdinal = 0;
    let audioOrdinal = 0;
    for (let i = 0; i < input.sources.length; i++) {
        const demux = `demux_${i}`;
        const source = input.sources[i];
        if (isVideoInputPort(source.sinkPortId)) {
            const pid = videoStreamPid(videoOrdinal++);
            linkOnPadAdded.push({
                from: demux,
                media: 'video',
                branches: [inputQueue],
                linkTo: 'mux',
                requestedPadNames: [muxSinkPadName(pid)],
            });
            namedStreams.push({
                pid,
                media: 'video',
                sinkPortId: source.sinkPortId,
                name: source.name,
                sourceModuleId: source.sourceModuleId,
            });
        }
        if (isAudioInputPort(source.sinkPortId)) {
            const pid = audioStreamPid(audioOrdinal++);
            linkOnPadAdded.push({
                from: demux,
                media: 'audio',
                branches: [inputQueue],
                linkTo: 'mux',
                requestedPadNames: [muxSinkPadName(pid)],
            });
            namedStreams.push({
                pid,
                media: 'audio',
                sinkPortId: source.sinkPortId,
                name: source.name,
                sourceModuleId: source.sourceModuleId,
            });
        }
    }

    return { pipeline, linkOnPadAdded, namedStreams };
}

/** Sort a list of input sources so the resulting pipeline is deterministic. */
export function sortSources(sources: UdpInputSource[]): UdpInputSource[] {
    return [...sources].sort((a, b) => a.sinkPortId.localeCompare(b.sinkPortId));
}

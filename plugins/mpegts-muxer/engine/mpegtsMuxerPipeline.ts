/**
 * Pure pipeline-assembly helpers for the MPEG-TS muxer.
 *
 * Kept free of GStreamer / engine imports so they can be unit-tested with
 * plain inputs.
 */

import {
    audioStreamPid,
    buildBackpressureQueue,
    buildBusSink,
    buildBusSrc,
    buildLeakyQueue,
    busStallWatch,
    muxSinkPadName,
    TS_METADATA_PID,
    videoStreamPid,
    type InputStallWatch,
    type PadLinkRule,
    type DynamicPort,
} from '@media-router/engine';

// Shared engine type. Note: muxer ports never set `streamInfo.pid` — muxer
// PIDs are assigned by CONNECTED-source ordinal at build time, so a
// port-index PID would lie on partially-wired setups.
export type { DynamicPort };

export interface UdpInputSource {
    /** Sink port id this connection arrives on (e.g. "video-0", "audio-2"). */
    sinkPortId: string;
    port: number;
    /** Operator-set name for this input (live-updatable). Blank → fall back. */
    name?: string | null;
    /** Connected source module id (D4 name fallback when no operator name). */
    sourceModuleId?: string | null;
    /** Per-consumer edge socket (falls back to the channel socket). */
    socketPath?: string;
    /** Lipsync offset (ms) for this input's mux pad — see StreamEntry.offsetMs. */
    offsetMs?: number;
    /** ISO 639 language code for this input's PMT descriptor — see
     *  StreamEntry.language. Blank/absent → pass the source's language through. */
    language?: string;
}

const VIDEO_PORT_PREFIX = 'video-';
const AUDIO_PORT_PREFIX = 'audio-';
const OUTPUT_PORT_ID = 'mpegts-out';

/**
 * Per-input stall watch (5 s, in ms). A silent-but-connected input —
 * producer alive but its source dark — is otherwise invisible: unixfdsrc
 * posts no bus error, so the muxer's aggregator quietly stalls its output
 * with no signal to trigger `restartOnError`. The runner-side watch
 * (`PipelineDescription.inputStallWatch`, one entry per input source) turns
 * the silence into a tagged error event, so a dark source recovers via the
 * normal restart path. An input that never delivered at all is waited for,
 * not restarted. Mechanism and history: `gst_input_stall_watch.py`. (A DEAD
 * producer needs no watch — its edge socket closes and unixfdsrc errors out
 * on its own.)
 */
const INPUT_STALL_TIMEOUT_MS = 5_000;

/**
 * Default bound (ms) on each per-pad NON-leaky input queue (`queueLeaky`
 * off, the default). Must exceed the worst legitimate inter-stream skew the
 * aggregator waits out (audio transcode chain ~200 ms, demuxer audio pacing
 * 160 ms, B-frame DTS delay ~120 ms — measured on gate01); 500 ms covers all
 * with margin. This is a runaway safety cap, not a latency budget:
 * steady-state occupancy equals the skew, and the cap only bites when a
 * sibling input genuinely stalls — where the stall watchdog (above) is the
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

/** One configured input stream. */
export interface StreamEntry {
    /** Operator-set name (blank = unset). */
    name: string;
    /**
     * Lipsync offset (ms) applied to this input's mux pad via
     * `GstPad.set_offset()` (audio inputs only — delaying video would add real
     * latency). Negative advances the stream on the mux timeline: use
     * `-<measured audio-late skew>` to cancel a stable path offset with no
     * added latency (costs ~|offset| of clipped audio at pipeline start).
     * Clamped ±2000; 0/absent → no offset applied (rule shape unchanged).
     */
    offsetMs: number;
    /**
     * ISO 639 language code (2/3-letter, e.g. en / eng / deu) written into the
     * output PMT as this stream's language descriptor via a `taginject` in the
     * input branch (mpegtsmux converts any accepted form to ISO 639-2B on the
     * wire). Empty → no taginject, so whatever language the SOURCE TS carries
     * passes through tsdemux→mpegtsmux untouched. Applied at build time —
     * changing it restarts the muxer (a live `tags` property change is not
     * reliably re-emitted by taginject).
     */
    language: string;
}

const MAX_OFFSET_MS = 2000;

/** Clamp a raw config offset to ±2000 ms; malformed → 0. */
function normalizeOffsetMs(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, n));
}

/** Sanitize a raw config language to a bare ISO 639 code; anything else → ''.
 *  The strict 2-3 letter shape doubles as launch-string safety — the value is
 *  interpolated into `taginject tags=…` and can never need quoting. */
function normalizeLanguage(raw: unknown): string {
    return typeof raw === 'string' && /^[A-Za-z]{2,3}$/.test(raw) ? raw.toLowerCase() : '';
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
                    ? (e as { name: string }).name
                    : '',
            offsetMs: normalizeOffsetMs((e as { offsetMs?: unknown } | null)?.offsetMs),
            language: normalizeLanguage((e as { language?: unknown } | null)?.language),
        }));
    }
    const count = Math.max(
        0,
        (config[media === 'video' ? 'videoStreamCount' : 'audioStreamCount'] as number) ?? 1,
    );
    const legacyNames = (config.streamNames as Record<string, string> | undefined) ?? {};
    return Array.from({ length: Math.min(count, MAX_STREAMS[media]) }, (_, i) => ({
        name: legacyNames[`${media}-${i}`] ?? '',
        offsetMs: 0,
        language: '',
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

/** Compact stream identity for a muxer input pin — operator name and/or
 *  language when set, undefined otherwise (pin keeps its role label). */
function entryStreamInfo(entry: StreamEntry, media: 'video' | 'audio'): DynamicPort['streamInfo'] {
    const name = entry.name.trim();
    if (!name && !entry.language) return undefined;
    return {
        media,
        ...(name ? { name } : {}),
        ...(entry.language ? { language: entry.language } : {}),
    };
}

/**
 * Build the dynamic port list that mirrors the configured stream entries.
 * The output port is always present so downstream players can connect even
 * when no inputs are configured yet.
 */
export function buildDynamicPorts(
    videoStreams: StreamEntry[],
    audioStreams: StreamEntry[],
): DynamicPort[] {
    const ports: DynamicPort[] = [];
    for (let i = 0; i < videoStreams.length; i++) {
        const streamInfo = entryStreamInfo(videoStreams[i], 'video');
        ports.push({
            id: videoPortId(i),
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: `Video ${i + 1}`,
            maxConnections: 1,
            ...(streamInfo ? { streamInfo } : {}),
        });
    }
    for (let i = 0; i < audioStreams.length; i++) {
        const streamInfo = entryStreamInfo(audioStreams[i], 'audio');
        ports.push({
            id: audioPortId(i),
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: `Audio ${i + 1}`,
            maxConnections: 1,
            // Audio slots take an audio ES in a muxed TS OR a 302M stream
            // (PCM muxes into the program like any audio) — dual-color dot.
            acceptsAnyTs: true,
            ...(streamInfo ? { streamInfo } : {}),
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
 *
 * EACH BRANCH ZEROES ITS OWN TIMELINE, which is why the description also asks
 * for `alignBranchesToStamps` (see `buildPipeline` → `demuxes`): a `tsdemux`
 * takes its basis from the bus buffer it locked on, and on a reordered stream
 * that one stamp can be up to the reorder depth late (the producer's monotone
 * floor), so the branches leave the mux 100–121 ms apart from inputs 0.001 ms
 * apart — re-drawn on every restart. The runner anchors each branch to the
 * producer's stamped house timeline instead; the option is dropped when the
 * time-sync contract is off, where there are no house stamps to anchor to.
 */
export function buildInputBranch(branchId: string, source: UdpInputSource): string {
    const src = buildBusSrc({
        port: source.port,
        socketPath: source.socketPath,
        name: inputBusSrcName(branchId),
    });
    // The stall watch (see `inputStallWatch` in buildPipeline — the runner
    // watches `busin_<i>`'s src pad, no `watchdog` element in the branch) is
    // load-bearing on a MULTI-source mux, not just a nicety: `mpegtsmux`
    // aggregates all its sink pads and CANNOT distinguish a late pad from a
    // dead one, so when any single input goes dark it stalls the WHOLE
    // combined output indefinitely (spike: `multi_source_dark_input.py` — 1
    // output buffer in the 6.5 s after one of two inputs was killed). With no
    // watch that stall is silent and unrecoverable. The watch turns it into a
    // tagged runner error → `restartOnError` rebuild, which is the only
    // available recovery: the healthy inputs are already frozen by the stall,
    // so the restart disrupts nothing that was still flowing. The restart does
    // loop while a source that WAS flowing stays permanently dark — making the
    // mux survive a dead input without a rebuild needs per-pad
    // keepalive/fallback (a real feature, not a tuning knob), since mpegtsmux
    // has no drop-dead-pad mode. An input that never delivered is different:
    // it has no mux pad yet (pads are requested on tsdemux pad-added), so the
    // mux runs on the fed inputs and the watch only warns (see
    // gst_input_stall_watch.py).
    // `tsdemux latency=0` removes its default 700 ms input buffer — the
    // per-pad leaky queue downstream provides flow control.
    return `${src} ! tsdemux latency=0 name=demux_${branchId}`;
}

/** Element name of input branch `i`'s bus source (what the stall watch and
 *  the tests address). */
export function inputBusSrcName(branchId: string): string {
    return `busin_${branchId}`;
}

export interface MuxerPipelineInputs {
    sources: UdpInputSource[];
    output: { port: number };
    alignment: number;
    /** Input queue behaviour (defaults to false = non-leaky). See the
     *  queueLeaky doc above MUX_INPUT_QUEUE_MS. */
    queueLeaky?: boolean;
    /** Queue bound in ms (defaults to MUX_INPUT_QUEUE_MS, clamped 100–5000).
     *  Non-leaky: set to at least the worst inter-stream skew of the wiring
     *  (transcode chain, pacing offset, B-frame delay). Leaky: the backlog
     *  tolerance before shedding starts. */
    queueDepthMs?: number;
    /** Emit the in-band stream-info channel (KLV carousel on the metadata PID)
     *  + pin the PCR to the first media stream. Default true; off → pipeline
     *  byte-identical to the no-metadata shape. */
    emitStreamInfo?: boolean;
}

/** One muxed stream's identity: which sink port fed it, the branch that demuxes
 *  it, and the deterministic output PID it is pinned to. The module joins
 *  `stream:discovered` events (keyed by demux element + media) back to output
 *  PIDs through this. */
export interface MuxedStreamPid {
    sinkPortId: string;
    media: 'video' | 'audio';
    pid: number;
    /** `demux_<i>` element name of this stream's input branch. */
    demux: string;
}

export interface MuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
    /** Output-PID map for every routed stream (see MuxedStreamPid). */
    streamPids: MuxedStreamPid[];
    /** True when the pipeline contains the `klvsrc` stream-info appsrc. */
    hasStreamInfo: boolean;
    /** Every input branch's `tsdemux`, for `alignBranchesToStamps` — the
     *  contract-only fix for per-branch zero points (see buildInputBranch). */
    demuxes: string[];
    /** One stall watch per input source (INPUT_STALL_TIMEOUT_MS), for
     *  `PipelineDescription.inputStallWatch`. */
    inputStallWatch: InputStallWatch[];
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
    const inputQueue =
        (input.queueLeaky ?? false) ? buildLeakyQueue(depth) : buildBackpressureQueue(depth);
    const branches = input.sources.map((s, i) => buildInputBranch(String(i), s));

    // Deterministic output PIDs (plan D3), assigned BEFORE the mux element is
    // formatted so the prog-map below can reference them. video-N → 0x100+N,
    // audio-N → 0x140+N, where N is the 0-based ordinal *within* that media
    // type — counted in source-sort order so the same wiring always maps to
    // the same PIDs across restarts. The demuxer on the far end then keeps
    // stable port identity, and the PID is the join key for in-band naming.
    // Without this, mpegtsmux auto-numbers PIDs and they drift.
    const streamPids: MuxedStreamPid[] = [];
    let videoOrdinal = 0;
    let audioOrdinal = 0;
    for (let i = 0; i < input.sources.length; i++) {
        const source = input.sources[i];
        if (isVideoInputPort(source.sinkPortId)) {
            streamPids.push({
                sinkPortId: source.sinkPortId,
                media: 'video',
                pid: videoStreamPid(videoOrdinal++),
                demux: `demux_${i}`,
            });
        }
        if (isAudioInputPort(source.sinkPortId)) {
            streamPids.push({
                sinkPortId: source.sinkPortId,
                media: 'audio',
                pid: audioStreamPid(audioOrdinal++),
                demux: `demux_${i}`,
            });
        }
    }

    // In-band stream-info channel (KLV carousel, plan D2). HARD INVARIANT:
    // the metadata appsrc and the PCR pin below are emitted by this one code
    // path TOGETHER — the KLV pad must NEVER carry the load-bearing PCR.
    // That was the original retirement bug: mpegtsmux picked the live appsrc
    // (do-timestamp) as the PCR stream, so the receiver's clock was driven by
    // the ~50 ms carousel software timer instead of the media, surfacing as
    // sporadic audio drops. `prog-map` pins every pad to program 1 and PCR_1
    // to the first media stream (video preferred — the media clock), which is
    // exactly what mpegtsmux does on its own when no metadata pad exists.
    const emitStreamInfo = input.emitStreamInfo ?? true;
    const pcrPid = streamPids.find((s) => s.media === 'video')?.pid ?? streamPids[0]?.pid;
    let muxProps = `alignment=${input.alignment}`;
    let metadataBranch = '';
    if (emitStreamInfo && pcrPid !== undefined) {
        const progEntries = [...streamPids.map((s) => s.pid), TS_METADATA_PID]
            .map((pid) => `${muxSinkPadName(pid)}=(int)1`)
            .join(',');
        muxProps += ` prog-map="program_map,${progEntries},PCR_1=${muxSinkPadName(pcrPid)}"`;
        // `is-live=false` on purpose (2026-09-02). A LIVE appsrc pad enters the
        // aggregator's latency arithmetic and makes it impossible (its max
        // latency is below the media pads' min), so `mpegtsmux` posted the
        // "Impossible to configure latency: max < min" WARNING on the bus about
        // 130 times a second — every one a main-loop wakeup marshalled into
        // the runner's python bus handler. Measured in the muxer rig
        // (spike/muxer_rig.py): runner 63 → 34 ticks/10 s, main thread 17 → 5,
        // mux:src 27 → 11, bus messages 129/s → 0, with the output identical
        // (same buf/s, kbps, video AU/s, 19.5 KLV PES/s with monotonic PTS). A
        // non-live pad is simply excluded from that computation; `do-timestamp`
        // still stamps each push with the running time, which is all the
        // carousel needs to keep the metadata pad's timestamps advancing.
        metadataBranch =
            ' appsrc name=klvsrc is-live=false do-timestamp=true format=time' +
            ` caps="meta/x-klv,parsed=true" ! mux.${muxSinkPadName(TS_METADATA_PID)}`;
    }

    // TEST (2026-07-16, sporadic-drop hunt): give the aggregator a real
    // latency budget. Measured in the live muxer: buffers arrive ~1s late vs
    // the pipeline clock (cross-process bus hides upstream latency, so the
    // latency query reports ~0) — with latency=0 the aggregator's deadline is
    // always already expired, so it never waits to interleave pads by PTS and
    // muxes by arrival; upstream jitter then lands as backward-DTS timeline
    // jolts ("ignoring DTS going backward") and invalid PTS<DTS audio PES the
    // receiver discards in bursts. 1.2s covers the observed ~1.07s lateness.
    const muxer =
        'mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 ' + muxProps;
    const sink = buildBusSink(input.output.port);
    // No leaky queue between mpegtsmux and the bus tee: any drop here is a
    // mid-stream TS slice (part of a frame's payload) and corrupts decode
    // at the receiver.
    const pipeline = `${muxer} ! ${sink}${metadataBranch} ${branches.join(' ')}`;

    // Per-source pad-link rules: each tsdemux gets one rule per media type.
    // No codec parser in the branch — the Python pad-link runner injects the
    // matching parser at pad-added time from the actual pad caps, which
    // means upstream codec changes (or audio-only sources signalling video
    // by mistake) don't take this plugin's pipeline-build path down.
    // Each rule requests the exact `sink_<pid>` pad computed above.
    const bySinkPort = new Map(streamPids.map((s) => [`${s.media}:${s.sinkPortId}`, s]));
    const linkOnPadAdded: PadLinkRule[] = [];
    for (const source of input.sources) {
        const video = bySinkPort.get(`video:${source.sinkPortId}`);
        if (video) {
            linkOnPadAdded.push({
                from: video.demux,
                media: 'video',
                branches: [inputQueue],
                linkTo: 'mux',
                requestedPadNames: [muxSinkPadName(video.pid)],
            });
        }
        const audio = bySinkPort.get(`audio:${source.sinkPortId}`);
        if (audio) {
            // Lipsync offset on the mux request pad (audio only — offsetting
            // video would add real latency). Omitted when 0 so the default
            // rule shape stays byte-identical to today's. An operator language
            // appends a `taginject` whose language-code tag mpegtsmux turns
            // into this stream's ISO 639 PMT descriptor (overriding whatever
            // the source TS carried); blank → source language passes through.
            const offsetMs = normalizeOffsetMs(source.offsetMs);
            const language = normalizeLanguage(source.language);
            const branch = language
                ? `${inputQueue} ! taginject name=lang_${audio.pid} tags=language-code=${language}`
                : inputQueue;
            linkOnPadAdded.push({
                from: audio.demux,
                media: 'audio',
                branches: [branch],
                linkTo: 'mux',
                requestedPadNames: [muxSinkPadName(audio.pid)],
                ...(offsetMs !== 0 ? { padOffsetNs: offsetMs * 1_000_000 } : {}),
            });
        }
    }

    return {
        pipeline,
        linkOnPadAdded,
        streamPids,
        hasStreamInfo: emitStreamInfo && pcrPid !== undefined,
        demuxes: input.sources.map((_s, i) => `demux_${i}`),
        inputStallWatch: input.sources.map((_s, i) =>
            busStallWatch(inputBusSrcName(String(i)), INPUT_STALL_TIMEOUT_MS),
        ),
    };
}

/** Sort a list of input sources so the resulting pipeline is deterministic. */
export function sortSources(sources: UdpInputSource[]): UdpInputSource[] {
    return [...sources].sort((a, b) => a.sinkPortId.localeCompare(b.sinkPortId));
}

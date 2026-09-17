/**
 * Pure pipeline-assembly helpers for the MPEG-TS muxer: the `mpegtsmux`
 * element, one `tsdemux` branch per wired input, and the `mux_routing` hook
 * config the plugin's own runner hook (`py/mux_routing.py`, installed through
 * the engine's generic `runnerHooks` seam) links pads with at pad-added time —
 * every elementary stream sorted by ROUTE CLASS (video, audio, klv = the
 * WebVTT carrier of ADR-0016, subtitle = DVB / teletext) to its slot's PID,
 * anything unrouted sunk into a fakesink so a KLV-only source can no longer
 * kill the demuxer with NOT_LINKED (the 2026-09-15 .103 restart loop). The
 * engine carries no muxer knowledge (ADR-0002).
 *
 * Config reading lives in `muxerInputs.ts`, the PID slot layout in
 * `muxerSlots.ts`; both are re-exported here so the module and its tests have
 * one import. Kept free of GStreamer imports so it unit-tests with plain
 * inputs.
 *
 * There is NO in-band name channel any more (2026-09-16): the KLV "stream-info
 * carousel" on PID 0x1f0 was retired — nothing on the fleet read it and every
 * splitter behind a muxer listed it as a stray port. Stream identity travels
 * the official way only: ISO 639 language descriptors in the PMT, written by
 * mpegtsmux from the input's `language` (audio today; other classes once
 * mpegtsmux carries the descriptor for them).
 */

import {
    buildBackpressureQueue,
    buildBusSink,
    buildBusSrc,
    buildLeakyQueue,
    busStallWatch,
    muxSinkPadName,
    tsQueueByteCap,
    type InputStallWatch,
    type RunnerHook,
} from '@media-router/engine';
import {
    MUX_ROUTING_MODULE,
    TS_METADATA_PID,
    type MuxRoute,
    type MuxRouteMedia,
    type MuxRoutingConfig,
    type MuxRoutingInput,
} from './muxPids.js';
import { normalizeLanguage, normalizeOffsetMs, type UdpInputSource } from './muxerInputs.js';
import {
    findPidConflicts,
    layoutSlots,
    MuxerPidConflictError,
    type MuxedStreamSlot,
} from './muxerSlots.js';

export * from './muxerInputs.js';
export * from './muxerSlots.js';

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
/**
 * Build a single demux branch for one connected input. The branch ends at
 * `tsdemux name=demux_${branchId}` — its dynamic pads are bridged to
 * `mpegtsmux name=mux` at runtime by the plugin's `mux_routing` hook
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
    /** Skip the runner-injected h26xparse on the VIDEO routes
     *  (`MuxRoute.parser = 'none'`). tsdemux already hands the mux one whole
     *  access unit per buffer; the parser only adds a frame of latency (41 ms
     *  at 25 fps, measured 2026-09-04) while waiting for the next AU to close
     *  the current one. Requires sources that repeat SPS/PPS in-band (ours do).
     *  Default false. */
    videoParserBypass?: boolean;
}

export interface MuxerPipelineResult {
    pipeline: string;
    /** The `mux_routing` hook config — one entry per input (see py/mux_routing.py). */
    routing: MuxRoutingConfig;
    /** `[{ module: 'mux_routing', config: routing }]` for the PipelineDescription. */
    runnerHooks: RunnerHook[];
    /** Every PID slot the rules can fill (see MuxedStreamSlot). */
    slots: MuxedStreamSlot[];
    /** Every input branch's `tsdemux`, for `alignBranchesToStamps` — the
     *  contract-only fix for per-branch zero points (see buildInputBranch). */
    demuxes: string[];
    /** One stall watch per input source (INPUT_STALL_TIMEOUT_MS), for
     *  `PipelineDescription.inputStallWatch`. */
    inputStallWatch: InputStallWatch[];
}

/**
 * Assemble the full pipeline + the `mux_routing` hook config, one input per
 * source.
 *
 * For each input, we expose a named `tsdemux` and describe, per route class,
 * where its first pad goes: its slot's `mux.sink_<pid>`. The branch itself is
 * a parser-free `queue` — the hook (`py/mux_routing.py`, run inside the
 * engine's pipeline runner) inspects each pad's caps at pad-added time,
 * prepends the matching parser and links the bin's src into the named
 * muxer's request sink pad. Pads with no route (a second audio stream, an
 * unknown private stream, an upstream muxer's name carousel on 0x1f0) are
 * sunk by the hook so the demuxer keeps flowing.
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
    // Byte cap next to the time bound (engine `queueBounds.ts`, ADR-0015):
    // these pads carry compressed ES only, and a time bound is blind to stalled
    // stamps. On the NON-leaky shape the cap BLOCKS at 4 MB (default depth)
    // exactly as the time bound blocks at 500 ms whenever stamps are sane; it
    // only ever fires when they are not, where the alternative is unbounded
    // growth. Blocking one pad stalls the demuxer feeding it, and the input
    // stall watch turns that into a module restart — the designed recovery.
    const cap = tsQueueByteCap(depth);
    const inputQueue =
        (input.queueLeaky ?? false)
            ? buildLeakyQueue(depth, cap)
            : buildBackpressureQueue(depth, cap);
    const branches = input.sources.map((s, i) => buildInputBranch(String(i), s));

    // Deterministic output PIDs (plan D3, generalised — see layoutSlots),
    // assigned BEFORE the mux element is formatted so the prog-map below can
    // reference them. Without pinned request-pad names mpegtsmux auto-numbers
    // PIDs and they drift between restarts.
    const slots = layoutSlots(input.sources);
    // Two request pads on one PID: mpegtsmux fails the second link and the
    // runner reports a pipeline error — a restart loop with a cryptic message.
    // Refuse to build instead and say exactly which two streams clash.
    const conflicts = findPidConflicts(slots);
    if (conflicts.length > 0) throw new MuxerPidConflictError(conflicts);

    // `prog-map` pins every slot to program 1 and seeds PCR_1 with the first
    // video slot (else the first audio slot). The builder cannot know which
    // input will actually carry video, so every hook input also carries `pcr`:
    // the hook re-points PCR_1 at the first video pad it links (else the first
    // audio pad) — inline PCR on the media clock, never on a data stream.
    const pcrSlot =
        slots.find((s) => s.media === 'video') ??
        slots.find((s) => s.media === 'audio') ??
        slots[0];
    const progEntries = slots.map((s) => `${muxSinkPadName(s.pid)}=(int)1`).join(',');
    const muxProps =
        `alignment=${input.alignment}` +
        ` prog-map="program_map,${progEntries},PCR_1=${muxSinkPadName(pcrSlot.pid)}"`;

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
    const pipeline = `${muxer} ! ${sink} ${branches.join(' ')}`;

    // One hook input per source. No codec parser in the branch — the hook
    // injects the matching parser at pad-added time from the actual pad caps,
    // which means upstream codec changes don't take this plugin's
    // pipeline-build path down. Each route requests the exact `sink_<pid>`
    // pad of its slot.
    const inputs: MuxRoutingInput[] = input.sources.map((source, i) => {
        const demux = `demux_${i}`;
        const routes: Partial<Record<MuxRouteMedia, MuxRoute>> = {};
        for (const slot of slots) {
            if (slot.demux !== demux) continue;
            const route: MuxRoute = { padName: muxSinkPadName(slot.pid), branch: inputQueue };
            if (slot.media === 'video' && input.videoParserBypass) route.parser = 'none';
            // A cue stream has one buffer per cue: without GAP keepalive the
            // aggregator holds the video up to latency + min-upstream-latency
            // (2.4 s here) whenever the pad is idle, then bursts it (the .108
            // 0.5 fps, 2026-09-16). The hook also restamps the branch to the
            // mux position on every buffer — see MuxRoute.sparse.
            if (slot.media === 'klv' || slot.media === 'subtitle') route.sparse = true;
            // An operator language appends a `taginject` whose language-code tag
            // mpegtsmux turns into the stream's ISO 639 PMT descriptor — the
            // official carrier of stream identity, what the fleet's splitters
            // label from ("Audio nor (aac, PID …)"). On every non-video class:
            // audio gets the descriptor today, klv/teletext once mpegtsmux
            // writes it for them. Blank → the source language passes through.
            const language = normalizeLanguage(source.language);
            if (language && slot.media !== 'video') {
                route.branch = `${inputQueue} ! taginject name=lang_${slot.pid} tags=language-code=${language}`;
            }
            if (slot.media === 'audio') {
                // Lipsync offset on the mux request pad (audio only — offsetting
                // video would add real latency). Omitted when 0 so the default
                // route shape stays byte-identical.
                const offsetMs = normalizeOffsetMs(source.offsetMs);
                if (offsetMs !== 0) route.padOffsetNs = offsetMs * 1_000_000;
            }
            routes[slot.media] = route;
        }
        return {
            demux,
            linkTo: 'mux',
            routes,
            // A muxer from before 2026-09-16 upstream still emits its name
            // carousel on the metadata PID — never re-mux that.
            ignorePids: [TS_METADATA_PID],
            pcr: { program: 1 },
        };
    });
    const routing: MuxRoutingConfig = { inputs };

    return {
        pipeline,
        routing,
        runnerHooks: [{ module: MUX_ROUTING_MODULE, config: routing }],
        slots,
        demuxes: input.sources.map((_s, i) => `demux_${i}`),
        inputStallWatch: input.sources.map((_s, i) =>
            busStallWatch(inputBusSrcName(String(i)), INPUT_STALL_TIMEOUT_MS),
        ),
    };
}

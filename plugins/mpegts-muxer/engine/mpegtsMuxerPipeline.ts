/**
 * Pure pipeline-assembly helpers for the MPEG-TS muxer: the `mpegtsmux`
 * element, one `mrtsdemux` branch per wired input, and the `mux_routing` hook
 * config the plugin's own runner hook (`py/mux_routing.py`, installed through
 * the engine's generic `runnerHooks` seam) links pads with at pad-added time —
 * every elementary stream sorted by ROUTE CLASS (video, audio, klv = the
 * WebVTT carrier of ADR-0016, subtitle = DVB / teletext) onto its input's
 * PID (a multi-stream input's further classes on the next free PIDs),
 * anything unrouted sunk into a fakesink so a KLV-only source can no longer
 * kill the demuxer with NOT_LINKED (the 2026-09-15 .103 restart loop). The
 * engine carries no muxer knowledge (ADR-0002).
 *
 * THE MUX IS AN ALIGNER (house-clock plan part 4.6): each routed stream enters through its
 * own `mralignwatch`, non-live, so the mux waits for data or a gap on every pad and never
 * times out. A silent input is gapped at the shared pace and rejoins; a cue stream between cues.
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
    buildBusSink,
    buildBusSrc,
    muxSinkPadName,
    tsQueueByteCap,
    type RunnerHook,
} from '@media-router/engine';
import {
    MUX_ROUTE_PRIORITY,
    MUX_ROUTING_MODULE,
    TS_METADATA_PID,
    type MuxRoute,
    type MuxRouteMedia,
    type MuxRoutingConfig,
    type MuxRoutingInput,
} from './muxPids.js';
import { normalizeLanguage, type UdpInputSource } from './muxerInputs.js';
import {
    findPidConflicts,
    layoutSlots,
    MuxerPidConflictError,
    type MuxedStreamSlot,
} from './muxerSlots.js';

export * from './muxerInputs.js';
export * from './muxerSlots.js';

/** The `mpegtsmux` element, and the pace group of every route's aligner. */
const MUX_NAME = 'mux';

/** Byte cap of each route aligner's FIFO: ADR-0015's for its 5 s time bound. */
const ROUTE_QUEUE_BYTES = tsQueueByteCap(5_000);

/**
 * Build a single demux branch for one connected input. The branch ends at
 * `mrtsdemux name=demux_${branchId}`, the formula demux in demux mode (tsdemux's
 * pad names and caps, a pad per stream of every media) — its dynamic pads are
 * bridged to `mpegtsmux name=mux` at runtime by the plugin's `mux_routing` hook
 * returned alongside the pipeline (see `buildPipeline`).
 *
 * Goes straight from the bus src to the demux with no `tsparse` in between: re-deriving
 * PTS from PCR mid-pipeline rewrites buffer running-times onto a separate
 * timeline, and `mpegtsmux latency=0` re-emitting PCR from those values
 * surfaces at the receiver as visible packet loss on live video. The runner-
 * injected parser + the route's aligner downstream provide the only
 * buffering this branch needs.
 *
 * Every access unit leaves the demux at its PES PTS − 1 h, the house time its
 * producer wrote, cue pads included (house-clock WI-P3-14): the mux writes each
 * back at its own PES PTS, every branch on one timeline, with no branch alignment.
 */
export function buildInputBranch(branchId: string, source: UdpInputSource): string {
    const src = buildBusSrc({
        port: source.port,
        socketPath: source.socketPath,
        name: inputBusSrcName(branchId),
    });
    // No input buffer in the demux: each route's aligner FIFO downstream provides flow control.
    return `${src} ! mrtsdemux name=demux_${branchId}`;
}

/** Element name of input branch `i`'s bus source. */
export function inputBusSrcName(branchId: string): string {
    return `busin_${branchId}`;
}

/** A route's `seed-lateness` in ns, within the element's 0..1 h; undefined without a finite seed. */
export function routeSeedNs(seedMs: number | undefined): number | undefined {
    if (typeof seedMs !== 'number' || !Number.isFinite(seedMs)) return undefined;
    return Math.round(Math.min(Math.max(seedMs, 0), 3_600_000) * 1_000_000);
}

function seedClause(seedMs: number | undefined): string {
    const ns = routeSeedNs(seedMs);
    return ns === undefined ? '' : ` seed-lateness=${ns}`;
}

/** One route's branch after the hook's parser: its `mralignwatch` in the mux's pace group, then
 *  any language `taginject`. A cue class is `sparse`: never absent, gapped between cues. */
function routeBranch(tag: string, media: MuxRouteMedia, source: UdpInputSource): string {
    const sparse = media === 'klv' || media === 'subtitle';
    let branch =
        `mralignwatch name=aw_${tag} aligner=${MUX_NAME} input=${tag}` +
        ` max-size-bytes=${ROUTE_QUEUE_BYTES}` +
        (sparse ? ' sparse=true' : '') +
        seedClause(source.seedLatenessMs);
    // An operator language appends a `taginject` whose language-code tag
    // mpegtsmux turns into the stream's ISO 639 PMT descriptor — the
    // official carrier of stream identity, what the fleet's splitters
    // label from ("Audio nor (aac, PID …)"). On every non-video class:
    // audio gets the descriptor today, klv/teletext once mpegtsmux
    // writes it for them. Blank → the source language passes through.
    const language = normalizeLanguage(source.language);
    if (language && media !== 'video') {
        branch += ` ! taginject name=lang_${tag} tags=language-code=${language}`;
    }
    return branch;
}

export interface MuxerPipelineInputs {
    sources: UdpInputSource[];
    output: { port: number };
    alignment: number;
    /** Skip the runner-injected h26xparse on the VIDEO routes
     *  (`MuxRoute.parser = 'none'`). The demux already hands the mux one whole
     *  access unit (one PES) per buffer; the parser only adds a frame of latency (41 ms
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
}

/**
 * Assemble the full pipeline + the `mux_routing` hook config, one input per
 * source.
 *
 * For each input, we expose a named `mrtsdemux` and describe, per route class,
 * where its first pad goes: its slot's `mux.sink_<pid>`. The branch itself is
 * the route's aligner (`routeBranch`) — the hook (`py/mux_routing.py`, run
 * inside the engine's pipeline runner) inspects each pad's caps at pad-added
 * time, prepends the matching parser and links the bin's src into the named
 * muxer's request sink pad. Pads with no route (a second audio stream, an
 * unknown private stream, an upstream muxer's name carousel on 0x1f0) are
 * sunk by the hook so the demuxer keeps flowing.
 *
 * Returns null when no inputs are wired — the caller should set a health
 * warning rather than start an empty pipeline.
 */
export function buildPipeline(input: MuxerPipelineInputs): MuxerPipelineResult | null {
    if (input.sources.length === 0) return null;
    const branches = input.sources.map((s, i) => buildInputBranch(String(i), s));

    // Deterministic output PIDs (see layoutSlots): one per generic input,
    // one per class on a legacy port — assigned BEFORE the mux element is
    // formatted so the prog-map below can reference them. Without pinned
    // request-pad names mpegtsmux auto-numbers PIDs and they drift between
    // restarts.
    const slots = layoutSlots(input.sources);
    // Two request pads on one PID: mpegtsmux fails the second link and the
    // runner reports a pipeline error — a restart loop with a cryptic message.
    // Refuse to build instead and say exactly which two inputs clash.
    const conflicts = findPidConflicts(slots);
    if (conflicts.length > 0) throw new MuxerPidConflictError(conflicts);

    // `prog-map` pins every slot to program 1 and seeds PCR_1 with the first
    // legacy video slot (else the first legacy audio slot, else the first
    // input's PID). The builder cannot know which input will actually carry
    // video, so every hook input also carries `pcr`: the hook re-points PCR_1
    // at the first video pad it links (else the first audio pad) — inline PCR
    // on the media clock, never on a data stream. The extra PIDs a
    // multi-stream input spills onto are added to the prog-map by the hook.
    const pcrSlot =
        slots.find((s) => s.media === 'video') ??
        slots.find((s) => s.media === 'audio') ??
        slots[0];
    const progEntries = slots.map((s) => `${muxSinkPadName(s.pid)}=(int)1`).join(',');
    const muxProps =
        `alignment=${input.alignment}` +
        ` prog-map="program_map,${progEntries},PCR_1=${muxSinkPadName(pcrSlot.pid)}"`;

    // latency=0 and every pad non-live (its aligner): the mux waits for data or
    // a gap on each pad, so it never times out and never drops late data.
    const muxer = `mpegtsmux name=${MUX_NAME} latency=0 ` + muxProps;
    const sink = buildBusSink(input.output.port);
    // No leaky queue between mpegtsmux and the bus tee: any drop here is a
    // mid-stream TS slice (part of a frame's payload) and corrupts decode
    // at the receiver.
    const pipeline = `${muxer} ! ${sink} ${branches.join(' ')}`;

    // One hook input per source. No codec parser in the branch — the hook
    // injects the matching parser at pad-added time from the actual pad caps,
    // which means upstream codec changes don't take this plugin's
    // pipeline-build path down. A legacy port's routes request the exact
    // `sink_<pid>` of their class slot; a generic input hands the hook its
    // one `pid` and a route per class, and the hook picks each class's pad
    // from the source PMT (highest-priority class on `pid`, the rest on the
    // next free PIDs).
    const inputs: MuxRoutingInput[] = input.sources.map((source, i) => {
        const demux = `demux_${i}`;
        const mine = slots.filter((s) => s.demux === demux);
        const generic = mine.length === 1 && mine[0].media === undefined;
        const routes: Partial<Record<MuxRouteMedia, MuxRoute>> = {};
        // The routed classes are the priority list; `data` (anything else
        // the demux exposes) is deliberately NOT routed: mpegtsmux has no sink
        // caps for it, and a failed request-pad link is a pipeline error.
        const classes: Array<{ media: MuxRouteMedia; padName?: string; tag: string }> = generic
            ? MUX_ROUTE_PRIORITY.map((media) => ({ media, tag: `${demux}_${media}` }))
            : mine.map((s) => ({
                  media: s.media!,
                  padName: muxSinkPadName(s.pid),
                  tag: String(s.pid),
              }));
        for (const { media, padName, tag } of classes) {
            const route: MuxRoute = {
                ...(padName ? { padName } : {}),
                branch: routeBranch(tag, media, source),
            };
            if (media === 'video' && input.videoParserBypass) route.parser = 'none';
            routes[media] = route;
        }
        return {
            demux,
            linkTo: MUX_NAME,
            ...(generic ? { pid: mine[0].pid } : {}),
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
    };
}

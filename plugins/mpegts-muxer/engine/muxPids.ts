/**
 * PID scheme and route classes of the media-agnostic muxer (ADR-0017,
 * amended 2026-09-18) — plugin-local: the engine knows nothing of muxer
 * inputs (ADR-0002).
 *
 * ONE PID PER INPUT. A generic input's `pid` (config, written back when
 * automatic) is the output PID of the stream it carries — no offsets, no
 * blocks: what the operator types is what a downstream splitter sees. When an
 * input turns out to carry several streams (a transcoder's video + subtitle
 * cues, a whole TS), the highest-priority class (video, audio, klv, subtitle
 * — `MUX_ROUTE_PRIORITY`) takes the input's PID and each further class takes
 * the next free PID above it. That decision is the runner hook's, made from
 * the source PMT before any pad is linked, so it never depends on which pad
 * shows up first; the module learns the outcome on `mux:routed` events.
 *
 * Route classes a muxer input sorts a demuxed pad into: `klv` is
 * `meta/x-klv` (the WebVTT subtitle carrier of ADR-0016), `subtitle` is DVB
 * subtitles / teletext, `data` is anything else tsdemux exposes (nothing
 * routes it by default). The runner-side twin of `muxRouteMedia` is
 * `route_media_for_caps` in `py/mux_routing.py`; both are pinned to the same
 * caps table by muxPids.test.ts and mux_routing_test.py.
 */
import { TS_AUDIO_PID_BASE, TS_METADATA_PID, TS_VIDEO_PID_BASE } from '@media-router/engine';

export type MuxRouteMedia = 'video' | 'audio' | 'klv' | 'subtitle' | 'data';
export const TS_KLV_PID_BASE = 0x180;
export const TS_SUBTITLE_PID_BASE = 0x1a0;
export const TS_DATA_PID_BASE = 0x1c0;
/** Slots per route class on LEGACY ports — also the cap on a muxer's input count. */
export const MUX_SLOTS_PER_CLASS = 16;
export { TS_METADATA_PID };

/** Class order when one input carries several streams: the first class
 *  present takes the input's PID. Twin of `_PRIORITY` in py/mux_routing.py. */
export const MUX_ROUTE_PRIORITY: readonly MuxRouteMedia[] = ['video', 'audio', 'klv', 'subtitle'];

const MUX_ROUTE_PID_BASE: Record<MuxRouteMedia, number> = {
    video: TS_VIDEO_PID_BASE,
    audio: TS_AUDIO_PID_BASE,
    klv: TS_KLV_PID_BASE,
    subtitle: TS_SUBTITLE_PID_BASE,
    data: TS_DATA_PID_BASE,
};

/** Legacy per-class slot PID (`video-N` / `audio-N` ports keep the D3 ranges):
 *  the `media` stream of slot `index` (0-based, < MUX_SLOTS_PER_CLASS). */
export function muxSlotPid(media: MuxRouteMedia, index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= MUX_SLOTS_PER_CLASS) {
        throw new RangeError(`muxSlotPid: slot ${index} outside 0..${MUX_SLOTS_PER_CLASS - 1}`);
    }
    return MUX_ROUTE_PID_BASE[media] + index;
}

/** Elementary-stream PID range: below 0x20 is PSI/SI, 0x1fff is the null packet. */
export const MIN_ES_PID = 0x0020;
export const MAX_ES_PID = 0x1ffe;

/** Automatic input PIDs start here and step by this, leaving room for the
 *  extra streams of a multi-stream input (which take the next free PIDs). */
export const MUX_INPUT_PID_FIRST = 0x100;
export const MUX_INPUT_PID_STEP = 8;

/** PIDs an input may never be set to, with the reason shown to the operator.
 *  0x1f0 is the metadata PID older muxers used for their name carousel: every
 *  muxer still drops an upstream 0x1f0 (`ignorePids`), so a stream landing
 *  on it would vanish at the next hop. */
export const RESERVED_PIDS: ReadonlyArray<[number, string]> = [
    [0x1000, "mpegtsmux's PMT"],
    [TS_METADATA_PID, "the metadata PID older muxers' name carousel used (dropped downstream)"],
];

export function isReservedPid(pid: number): boolean {
    return RESERVED_PIDS.some(([r]) => r === pid);
}

/**
 * The next available automatic input PID: the lowest `MUX_INPUT_PID_FIRST +
 * k·MUX_INPUT_PID_STEP` that is neither in `taken` nor reserved. Adding an
 * input never moves an existing one — the existing PIDs are what `taken`
 * holds.
 */
export function nextFreeInputPid(taken: Iterable<number>): number {
    const used = new Set(taken);
    for (let pid = MUX_INPUT_PID_FIRST; pid <= MAX_ES_PID; pid += MUX_INPUT_PID_STEP) {
        if (!used.has(pid) && !isReservedPid(pid)) return pid;
    }
    throw new RangeError('nextFreeInputPid: no free PID left');
}

/** Route class for a tsdemux pad from its caps (a full caps string or just the
 *  structure name). Twin of `route_media_for_caps` in py/mux_routing.py. */
export function muxRouteMedia(caps: string): MuxRouteMedia {
    const name = caps.split(/[,;]/, 1)[0]?.trim() ?? '';
    if (name.startsWith('video/')) return 'video';
    if (name.startsWith('audio/')) return 'audio';
    if (name === 'meta/x-klv') return 'klv';
    if (name.startsWith('subpicture/') || name === 'application/x-teletext') return 'subtitle';
    return 'data';
}

/** Python module name of the plugin's runner hook (`py/mux_routing.py`). */
export const MUX_ROUTING_MODULE = 'mux_routing';

/** One route of a muxer input: how the FIRST pad of a route class is muxed. */
export interface MuxRoute {
    /** Request-pad name to ask the mux for (`sink_<pid>` pins the PID). Set
     *  on LEGACY ports only; a generic input leaves it out and the hook
     *  derives it from the input's `pid` (see `MuxRoutingInput.pid`). */
    padName?: string;
    /** parse_launch fragment between the hook-injected parser and the mux. */
    branch: string;
    /** Optional `GstPad.set_offset()` on the request pad (lipsync, audio only). */
    padOffsetNs?: number;
    /** `'none'` skips the video parser and declares alignment=au instead. */
    parser?: 'auto' | 'none';
    /** One buffer per cue: the hook restamps to the mux position and sends GAPs while idle. */
    sparse?: boolean;
}

/** One input of the `mux_routing` hook config — see py/mux_routing.py. */
export interface MuxRoutingInput {
    demux: string;
    linkTo: string;
    /** Generic input: the output PID of its stream. The hook puts the
     *  highest-priority class the source PMT carries here and every further
     *  class on the next free PID above it. Absent on legacy ports, whose
     *  routes carry fixed `padName`s. */
    pid?: number;
    routes: Partial<Record<MuxRouteMedia, MuxRoute>>;
    ignorePids?: number[];
    pcr?: { program: number };
}

export interface MuxRoutingConfig {
    inputs: MuxRoutingInput[];
}

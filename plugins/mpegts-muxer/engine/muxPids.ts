/**
 * PID scheme and route classes of the media-agnostic muxer (ADR-0017) —
 * plugin-local: the engine knows nothing of muxer input blocks (ADR-0002).
 *
 * Route classes a muxer input sorts a demuxed pad into, and the PID each
 * class is pinned to. `klv` is `meta/x-klv` (the WebVTT subtitle carrier of
 * ADR-0016), `subtitle` is DVB subtitles / teletext, `data` is anything else
 * tsdemux exposes (nothing routes it by default). The runner-side twin of
 * `muxRouteMedia` is `route_media_for_caps` in `py/mux_routing.py`; both are
 * pinned to the same caps table by muxPids.test.ts and mux_routing_test.py.
 */
import { TS_AUDIO_PID_BASE, TS_METADATA_PID, TS_VIDEO_PID_BASE } from '@media-router/engine';

export type MuxRouteMedia = 'video' | 'audio' | 'klv' | 'subtitle' | 'data';
export const TS_KLV_PID_BASE = 0x180;
export const TS_SUBTITLE_PID_BASE = 0x1a0;
export const TS_DATA_PID_BASE = 0x1c0;
/** Slots per route class — also the cap on a muxer's generic input count. */
export const MUX_SLOTS_PER_CLASS = 16;
export { TS_METADATA_PID };

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

/**
 * Generic muxer input PID blocks. Input N owns `MUX_INPUT_PID_STRIDE`
 * consecutive PIDs from `muxInputBasePid(N)`; each route class sits at a
 * fixed offset inside the block, so an operator sets ONE PID per input and
 * its streams follow: video +0, audio +1, klv +2, subtitle +3. Sixteen
 * inputs × 8 = 0x100..0x17f, clear of the 0x180 KLV range and of the
 * metadata PID 0x1f0.
 */
export const TS_INPUT_PID_BASE = 0x100;
export const MUX_INPUT_PID_STRIDE = 8;
export const MUX_CLASS_PID_OFFSET: Record<MuxRouteMedia, number> = {
    video: 0,
    audio: 1,
    klv: 2,
    subtitle: 3,
    data: 4,
};

/** Automatic base PID of generic muxer input `index` (0-based, < MUX_SLOTS_PER_CLASS). */
export function muxInputBasePid(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= MUX_SLOTS_PER_CLASS) {
        throw new RangeError(
            `muxInputBasePid: input ${index} outside 0..${MUX_SLOTS_PER_CLASS - 1}`,
        );
    }
    return TS_INPUT_PID_BASE + MUX_INPUT_PID_STRIDE * index;
}

/** PID of route class `media` inside the block starting at `basePid`. */
export function muxInputClassPid(basePid: number, media: MuxRouteMedia): number {
    return basePid + MUX_CLASS_PID_OFFSET[media];
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

/** One route of a muxer input: where the FIRST pad of a route class goes. */
export interface MuxRoute {
    /** Request-pad name to ask the mux for (`sink_<pid>` pins the PID). */
    padName: string;
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
    routes: Partial<Record<MuxRouteMedia, MuxRoute>>;
    ignorePids?: number[];
    pcr?: { program: number };
}

export interface MuxRoutingConfig {
    inputs: MuxRoutingInput[];
}

import type { ChannelMapEntry } from '@media-router/engine';
import { mixMatrixClause } from './channelMapMatrix.js';

/** GStreamer's default channel layouts for the 302M widths (FL FR / +RL RR / 5.1 / 7.1). */
export const POSITIONED_302M_MASK: Record<number, string> = {
    2: '0x3',
    4: '0x33',
    6: '0x3f',
    8: '0x63f',
};

/**
 * `audioconvert <identity mix-matrix> ! audio/x-raw,channels=N,channel-mask=<layout>`
 * — gives an unpositioned N-wide stream a channel layout before `avenc_s302m`,
 * which refuses a layout-less stream. Both halves are needed: audioconvert
 * neither invents positions for an unpositioned input without a mix-matrix nor
 * adds them when an equal-count identity leaves the layout untouched (bare
 * pipelines on gst 1.28.2, 2026-09-15). Unpositioned inputs are the norm for
 * wide 302M: `pipewiresrc` whole-device capture and `avdec_s302m` of any
 * 4/6/8-channel stream both come out `channel-mask=0x0`. 302M carries plain
 * PCM pairs, so the positions mean nothing downstream.
 */
export function positionedChannelsClause(channels: number): string {
    const identity: ChannelMapEntry[] = Array.from({ length: channels }, (_, i) => ({
        srcChannel: i,
        dstChannel: i,
    }));
    const mask = POSITIONED_302M_MASK[channels] ?? '0x0';
    return (
        `audioconvert${mixMatrixClause(identity, channels, channels)}` +
        ` ! audio/x-raw,channels=${channels},channel-mask=(bitmask)${mask}`
    );
}

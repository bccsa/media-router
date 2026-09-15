import type { ChannelMapEntry } from '@media-router/engine';
import { mixMatrixClause } from '@media-router/plugin-audio-302m-core';

export interface OutputPlacementOpts {
    /** PipeWire sink node name — only used in messages. */
    device: string;
    /** Width of the mix being played (1–8). */
    channels: number;
    /** 1-based first DEVICE channel the mix lands on. */
    firstChannel: number;
    /** Device width as PipeWire reports it; null when not enumerated. */
    deviceChannels: number | null;
}

export type OutputPlacement =
    | {
          /** Elements to splice between the VU `level` and the sink; null =
           *  legacy shape (positioned stream, no placement at all). */
          fragment: string | null;
          error?: undefined;
      }
    | { fragment?: undefined; error: string };

/**
 * Place an N-channel mix on device channels `firstChannel..firstChannel+N-1`.
 *
 * Playback mirror of the 302M input's capture shape (ADR-0014): PipeWire links
 * ports by channel POSITION, and a stream of ≤ 8 channels is given default
 * positions (FL, FR, …) that never match a multichannel card's AUX-named
 * ports — so a positioned 8-channel stream reaches two outputs. An
 * unpositioned stream (`channel-mask=0x0`) links port-for-port in index order
 * instead, whatever its width. So the mix is spread with an `audioconvert
 * mix-matrix` onto a stream exactly `lastChannel` wide — wide enough to reach
 * the last device channel it lands on, and not the device's full width: on an
 * X32 a mono output on channel 3 is a 3-channel stream, not a 48-channel one
 * (each pulse stream costs pipewire-pulse two scratch buffers per channel,
 * measured 10.9.16.50 2026-09-15). Unlike the capture side this stays on
 * WirePlumber's auto-link: pipewire-pulse never attaches a sink to a stream
 * with `node.autoconnect=false`, and pulsesink then cannot reach PLAYING.
 *
 * The DEFAULT range — stereo or mono from channel 1 — deliberately keeps the
 * legacy positioned stream: every existing profile's pipeline string stays
 * byte-identical (the contract kill-switch relies on that), and FL/FR on a
 * stereo DAC is exactly right there.
 */
export function buildOutputPlacement(o: OutputPlacementOpts): OutputPlacement {
    const channels = Math.max(1, Math.min(8, Math.trunc(o.channels) || 2));
    const firstChannel = Math.max(1, Math.trunc(o.firstChannel) || 1);
    const lastChannel = firstChannel - 1 + channels;

    if (firstChannel === 1 && channels <= 2) return { fragment: null };

    const deviceWidth = o.deviceChannels ?? 0;
    if (deviceWidth <= 0) {
        return {
            error:
                `Audio device "${o.device}" is not enumerated by PipeWire, so its channel ` +
                `count is unknown — needed to play on ${firstChannel}–${lastChannel}. ` +
                'Check the device is connected and re-pick it from the list.',
        };
    }
    if (lastChannel > deviceWidth) {
        return {
            error:
                `Audio device "${o.device}" has ${deviceWidth} channels — ` +
                `cannot play on ${firstChannel}–${lastChannel}`,
        };
    }

    // As wide as the last channel used, unpositioned → PipeWire links
    // port-for-port in index order; the matrix parks the mix at its columns.
    const width = lastChannel;
    const wide = `audio/x-raw,channels=${width},channel-mask=(bitmask)0x0`;
    if (firstChannel === 1 && channels === width) {
        return { fragment: `audioconvert ! ${wide}` };
    }
    const place: ChannelMapEntry[] = Array.from({ length: channels }, (_, i) => ({
        srcChannel: i,
        dstChannel: firstChannel - 1 + i,
    }));
    return { fragment: `audioconvert${mixMatrixClause(place, channels, width)} ! ${wide}` };
}

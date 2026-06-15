/**
 * Pure KLV name-carousel payload builder for the MPEG-TS muxer (plan D2/D4,
 * wire format in section 3 of docs/mpegts-dynamic-streams-plan.md).
 *
 * Kept free of GStreamer / engine imports so it's unit-testable with plain
 * inputs. The runner pushes the JSON this produces onto the fixed metadata PID
 * on a ~1 s carousel; the demuxer parses it back (see the demuxer's
 * `klvNames.ts`). This is a wire protocol crossing version boundaries during
 * rolling fleet upgrades — resist adding fields beyond `pid`/`media`/`name`.
 */

/** Wire-format version. Receivers ignore unknown versions (plan section 3). */
export const KLV_PAYLOAD_VERSION = 1;

export type KlvStreamMedia = 'video' | 'audio';

export interface KlvStreamEntry {
    /** The stream's pinned PID (the join key between detection and naming). */
    pid: number;
    media: KlvStreamMedia;
    /** Operator-facing label. */
    name: string;
}

export interface KlvPayload {
    v: number;
    streams: KlvStreamEntry[];
}

/**
 * One muxer input as known at build time: its pinned PID, media type, an
 * optional operator-set name, and the routing-graph fallback (the connected
 * source module id, per D4). The metadata PID itself is never an input here —
 * the channel only describes the elementary streams.
 */
export interface NamedStreamInput {
    pid: number;
    media: KlvStreamMedia;
    /**
     * Sink port id this stream entered on (`video-1`, `audio-0`). Carried so a
     * live rename can look the stream's name up by its port. PIDs are numbered
     * by CONNECTED-source ordinal, not port index — with `videoStreams: [A, B]`
     * and only `video-1` wired, the stream gets PID 0x100 but its name lives at
     * config index 1, so reverse-deriving the port from the PID mislabels it.
     */
    sinkPortId: string;
    /** Operator-set name from config; blank/absent → fall back. */
    name?: string | null;
    /** `sourceModuleId` from the engine's connection records (D4 fallback). */
    sourceModuleId?: string | null;
}

/**
 * Resolve the label for one stream: operator name → sourceModuleId → a generic
 * `<media> 0x<pid>` so the carousel always carries a non-empty name (the
 * downstream label-resolution order then layers the demuxer's own fallbacks
 * below the KLV name). Trims whitespace; an all-blank name is treated as unset.
 */
export function resolveStreamName(input: NamedStreamInput): string {
    const explicit = (input.name ?? '').trim();
    if (explicit) return explicit;
    const fromGraph = (input.sourceModuleId ?? '').trim();
    if (fromGraph) return fromGraph;
    return `${input.media} 0x${input.pid.toString(16)}`;
}

/**
 * Build the carousel payload object from the muxer's named inputs. Always emits
 * a payload (even with zero inputs) so the demuxer always sees the channel —
 * names fall back per `resolveStreamName`. Inputs are sorted by PID so the
 * byte stream is stable across restarts with identical wiring.
 */
export function buildKlvPayload(inputs: NamedStreamInput[]): KlvPayload {
    const streams = [...inputs]
        .sort((a, b) => a.pid - b.pid)
        .map((i) => ({ pid: i.pid, media: i.media, name: resolveStreamName(i) }));
    return { v: KLV_PAYLOAD_VERSION, streams };
}

/** Serialise the payload to the exact JSON bytes the runner pushes. */
export function serializeKlvPayload(payload: KlvPayload): string {
    return JSON.stringify(payload);
}

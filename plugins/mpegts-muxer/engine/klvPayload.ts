/**
 * Pure KLV name-carousel payload builder for the MPEG-TS muxer (plan D2/D4,
 * wire format in section 3 of docs/mpegts-dynamic-streams-plan.md).
 *
 * Kept free of GStreamer / engine imports so it's unit-testable with plain
 * inputs. The runner pushes the JSON this produces onto the fixed metadata PID
 * on a carousel; the demuxer parses it back (see the demuxer's `klvNames.ts`).
 * This is a wire protocol crossing version boundaries during rolling fleet
 * upgrades — the version stays 1 and new fields are OPTIONAL (v1 receivers
 * read `pid`/`name` and ignore extras).
 *
 * Layering rule: KLV carries ONLY what MPEG-TS cannot express natively.
 * Freeform names always; `codec`/`channels`/`rate` solely for streams with no
 * native TS signalling (WebVTT, unknown/private payloads — `nativeTs === false`
 * from the engine's `capsStreamInfo`). Natively-signalled codecs (h264, aac,
 * 302M via BSSD, …) and language (ISO 639 descriptor) are already on the wire
 * in the PMT and are never duplicated here.
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
    /** Codec id — present ONLY for codecs MPEG-TS cannot signal natively
     *  (see the layering rule in the file header). */
    codec?: string;
    channels?: number;
    rate?: number;
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
    /**
     * Codec identity discovered from the stream's actual pad caps at runtime
     * (the engine's `capsStreamInfo` result). The builder applies the layering
     * rule: codec/channels/rate reach the wire only when `nativeTs` is false —
     * natively-signalled codecs are already fully expressed in the PMT.
     */
    discovered?: { codec?: string; nativeTs: boolean; channels?: number; rate?: number };
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
        .map((i) => {
            const entry: KlvStreamEntry = {
                pid: i.pid,
                media: i.media,
                name: resolveStreamName(i),
            };
            // Layering rule (file header): codec info only for streams the TS
            // wire can't describe itself.
            const d = i.discovered;
            if (d?.codec && !d.nativeTs) {
                entry.codec = d.codec;
                if (d.channels) entry.channels = d.channels;
                if (d.rate) entry.rate = d.rate;
            }
            return entry;
        });
    return { v: KLV_PAYLOAD_VERSION, streams };
}

/** Serialise the payload to the exact JSON bytes the runner pushes. */
export function serializeKlvPayload(payload: KlvPayload): string {
    return JSON.stringify(payload);
}

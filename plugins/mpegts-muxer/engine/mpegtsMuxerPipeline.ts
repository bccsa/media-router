/**
 * Pure pipeline-assembly helpers for the MPEG-TS muxer.
 *
 * Kept free of GStreamer / engine imports so they can be unit-tested with
 * plain inputs.
 */

import {
    DEFAULT_MPEGTS_ALIGNMENT,
    buildLeakyQueue,
    buildUdpSink,
    buildUdpSrc,
    videoParserForCodec,
    type PadLinkRule,
} from '@media-router/engine';

export { videoParserForCodec };

export type PortDirection = 'input' | 'output';

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
}

export interface UdpInputSource {
    /** Sink port id this connection arrives on (e.g. "video-0", "audio-2"). */
    sinkPortId: string;
    host: string;
    port: number;
    /** Upstream encoder's codec (when known) so we can pick the right parser. */
    codec?: string;
}

const VIDEO_PORT_PREFIX = 'video-';
const AUDIO_PORT_PREFIX = 'audio-';
const OUTPUT_PORT_ID = 'mpegts-out';

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
    });
    return ports;
}

/**
 * Build a single demux branch for one connected input. The branch ends at
 * `tsdemux name=demux_${branchId}` — its dynamic pads are bridged to
 * `mpegtsmux name=mux` at runtime by the per-media `linkOnPadAdded` rules
 * returned alongside the pipeline (see `buildPipeline`).
 *
 * We declare the TS caps directly on udpsrc so negotiation does not depend
 * on data arriving from the upstream encoder — without this, an idle source
 * can cause downstream `not-negotiated` errors at PLAYING.
 */
export function buildInputBranch(branchId: string, source: UdpInputSource): string {
    const udpsrc = buildUdpSrc({
        host: source.host,
        port: source.port,
        caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
    });
    // `tsdemux latency=0` removes its default 700 ms input buffer — the queue
    // downstream of each pad already provides flow control.
    return `${udpsrc} ! tsdemux latency=0 name=demux_${branchId}`;
}

export interface MuxerPipelineInputs {
    sources: UdpInputSource[];
    output: { host: string; port: number };
    alignment: number;
    /** Per-pad queue size in milliseconds (defaults to 50). Lower = lower
     *  latency, higher = more jitter tolerance. */
    bufferMs?: number;
}

export interface MuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
}

/**
 * Assemble the full pipeline + per-media pad-link rules.
 *
 * For each input, we expose a named `tsdemux` and let the runner attach a
 * media-specific branch (`h264parse`/`h265parse` for video, identity-passthrough
 * for audio) per emitted pad and link the branch's src into the named muxer's
 * request sink pad. This avoids `parsebin` (which negotiates differently on
 * older GStreamer builds) and gives us deterministic per-codec parsing.
 *
 * Returns null when no inputs are wired — the caller should set a health
 * warning rather than start an empty pipeline.
 */
export function buildPipeline(input: MuxerPipelineInputs): MuxerPipelineResult | null {
    if (input.sources.length === 0) return null;
    const bufferMs = input.bufferMs ?? 50;
    const queue = buildLeakyQueue(bufferMs);
    const branches = input.sources.map((s, i) => buildInputBranch(String(i), s));
    const muxer = `mpegtsmux name=mux latency=0 alignment=${input.alignment}`;
    const sink = buildUdpSink({ name: 'usink', host: input.output.host, port: input.output.port });
    const pipeline = `${muxer} ! ${sink} ${branches.join(' ')}`;

    // Per-source pad-link rules: each tsdemux gets one rule per media type.
    // The branch `queue ! <parser>` is wrapped into a bin and bridged to
    // `mux` via the runner's `linkTo` mechanism. Video parser is picked from
    // the upstream encoder's `codec`; we only emit a video rule for sources
    // that actually arrive on a video input port — audio-only encoders don't
    // need (and won't fire) a video rule.
    const linkOnPadAdded: PadLinkRule[] = [];
    for (let i = 0; i < input.sources.length; i++) {
        const demux = `demux_${i}`;
        const source = input.sources[i];
        if (isVideoInputPort(source.sinkPortId)) {
            const parser = videoParserForCodec(source.codec);
            if (parser !== null) {
                linkOnPadAdded.push({
                    from: demux,
                    media: 'video',
                    branches: [`${queue} ! ${parser}`],
                    linkTo: 'mux',
                });
            }
        }
        if (isAudioInputPort(source.sinkPortId)) {
            linkOnPadAdded.push({
                from: demux,
                media: 'audio',
                branches: [queue],
                linkTo: 'mux',
            });
        }
    }

    return { pipeline, linkOnPadAdded };
}

/** Sort a list of input sources so the resulting pipeline is deterministic. */
export function sortSources(sources: UdpInputSource[]): UdpInputSource[] {
    return [...sources].sort((a, b) => a.sinkPortId.localeCompare(b.sinkPortId));
}

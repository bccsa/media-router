/**
 * Pure pipeline-assembly helpers for the MPEG-TS demuxer.
 *
 * The demuxer takes one inbound multi-program TS stream, demuxes it once with
 * a named `tsdemux`, and emits each elementary stream onto its own UDP
 * multicast group (one per configured output port). The actual pad → branch
 * fan-out is performed at runtime by the gst-pipeline-runner using the
 * `linkOnPadAdded` rules returned alongside the pipeline string.
 */

import {
    DEFAULT_MPEGTS_ALIGNMENT,
    buildLeakyQueue,
    buildUdpSink,
    buildUdpSrc,
    videoParserForCodec,
    type PadLinkRule,
} from '@media-router/engine';

export type PortDirection = 'input' | 'output';

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
}

const VIDEO_OUT_PREFIX = 'video-';
const AUDIO_OUT_PREFIX = 'audio-';
const INPUT_PORT_ID = 'mpegts-in';

export function videoPortId(index: number): string {
    return `${VIDEO_OUT_PREFIX}${index}`;
}
export function audioPortId(index: number): string {
    return `${AUDIO_OUT_PREFIX}${index}`;
}
export function inputPortId(): string {
    return INPUT_PORT_ID;
}

/** Dynamic-port list: one input, N video outputs, M audio outputs. */
export function buildDynamicPorts(videoCount: number, audioCount: number): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
    ];
    for (let i = 0; i < videoCount; i++) {
        ports.push({
            id: videoPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: `Video ${i + 1}`,
            maxConnections: -1,
        });
    }
    for (let i = 0; i < audioCount; i++) {
        ports.push({
            id: audioPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: `Audio ${i + 1}`,
            maxConnections: -1,
        });
    }
    return ports;
}

export interface DemuxerOutput {
    portId: string;
    host: string;
    port: number;
}

export interface DemuxerPipelineInputs {
    /** Upstream UDP source (from MediaRouter.getModuleUdpSource). */
    input: { host: string; port: number };
    videoOutputs: DemuxerOutput[];
    audioOutputs: DemuxerOutput[];
    /** Per-pad queue size in milliseconds (defaults to 50). Lower = lower
     *  latency, higher = more jitter tolerance. */
    bufferMs?: number;
    /** Video codec inside the input TS — picks the parser between `tsdemux`
     *  and the per-output `mpegtsmux`. Defaults to h264. */
    videoCodec?: string;
}

const DEMUX_NAME = 'demux';

export interface DemuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
}

/** Per-output branch: a single-program TS muxer feeding a unique multicast port.
 *  Video branches insert the parser for the configured codec so `mpegtsmux`
 *  receives the alignment it expects (`au`, not the `nal` that `tsdemux`
 *  emits). Audio branches pass through directly since `mpegtsmux` accepts
 *  opus/aac caps from `tsdemux` as-is. */
export function buildOutputBranch(
    out: DemuxerOutput,
    suffix: string,
    media: 'video' | 'audio',
    bufferMs: number,
    videoCodec: string,
): string {
    const sink = buildUdpSink({ name: `usink_${suffix}`, host: out.host, port: out.port });
    const queue = buildLeakyQueue(bufferMs);
    let parser = '';
    if (media === 'video') {
        const elt = videoParserForCodec(videoCodec);
        parser = elt ? `${elt} ! ` : '';
    }
    return `${queue} ! ${parser}mpegtsmux name=mux_${suffix} latency=0 alignment=${DEFAULT_MPEGTS_ALIGNMENT} ! ${sink}`;
}

/**
 * Assemble the demuxer pipeline. Returns null when there is no upstream input
 * connection — caller should set a health warning.
 *
 * Pipeline shape:
 *   udpsrc ! tsparse ! tsdemux name=demux
 * The runner then attaches `linkOnPadAdded` rules so each video/audio pad
 * gets its own pre-built branch (queue → mpegtsmux → udpsink) at runtime.
 */
export function buildPipeline(input: DemuxerPipelineInputs): DemuxerPipelineResult | null {
    const bufferMs = input.bufferMs ?? 50;
    const videoCodec = input.videoCodec ?? 'h264';
    const udpsrc = buildUdpSrc({
        host: input.input.host,
        port: input.input.port,
        caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
    });
    // `tsdemux latency=0` skips its 700 ms input buffer.
    const pipeline = `${udpsrc} ! tsdemux latency=0 name=${DEMUX_NAME}`;

    const linkOnPadAdded: PadLinkRule[] = [];
    if (input.videoOutputs.length > 0) {
        linkOnPadAdded.push({
            from: DEMUX_NAME,
            media: 'video',
            branches: input.videoOutputs.map((o, i) =>
                buildOutputBranch(o, `v${i}`, 'video', bufferMs, videoCodec),
            ),
        });
    }
    if (input.audioOutputs.length > 0) {
        linkOnPadAdded.push({
            from: DEMUX_NAME,
            media: 'audio',
            branches: input.audioOutputs.map((o, i) =>
                buildOutputBranch(o, `a${i}`, 'audio', bufferMs, videoCodec),
            ),
        });
    }

    return { pipeline, linkOnPadAdded };
}

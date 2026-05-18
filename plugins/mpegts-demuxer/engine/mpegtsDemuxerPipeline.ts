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
}

const DEMUX_NAME = 'demux';

export interface DemuxerPipelineResult {
    pipeline: string;
    linkOnPadAdded: PadLinkRule[];
}

/** Per-output branch: a single-program TS muxer feeding a unique multicast port.
 *
 *  No codec parser in the JS string. The Python pad-link runner inspects each
 *  pad's caps at pad-added time and prepends the right parser (`h264parse`,
 *  `aacparse`, `ac3parse`, …) before parsing the branch. That keeps this
 *  pipeline codec-agnostic and means one demuxer can serve mixed-codec
 *  streams (e.g. one AAC pad + one Opus pad) without per-pad config.
 *
 *  Tail is `mpegtsmux ! udpsink` with no queue between them — see the inline
 *  comment in the function body for why a leaky queue at this boundary
 *  corrupts decode rather than helping. */
export function buildOutputBranch(
    out: DemuxerOutput,
    suffix: string,
    media: 'video' | 'audio',
    bufferMs: number,
): string {
    const sink = buildUdpSink({ name: `usink_${suffix}`, host: out.host, port: out.port });
    // No leaky queue between mpegtsmux and udpsink: any drop here is a
    // mid-stream UDP buffer (~1316 B = 7 TS packets, part of a frame's
    // payload) and corrupts decode at the receiver. The kernel UDP send
    // buffer absorbs typical bursts on its own.
    if (media === 'video') {
        // Video queue placed AFTER the (runner-injected) parser so drops land
        // on whole access units, not mid-NAL — losing a sub-frame buffer
        // corrupts the AU and surfaces as packet loss until the next IDR.
        // `leaky=2 max-size-buffers=2` keeps latency to ≤2 frames and drops
        // a single complete frame under stall, which the decoder conceals.
        const videoQueue = `queue leaky=2 max-size-buffers=2 max-size-time=0 max-size-bytes=0`;
        return `${videoQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=${DEFAULT_MPEGTS_ALIGNMENT} ! ${sink}`;
    }
    // Audio queue after the (runner-injected) parser: drops land on whole
    // frames rather than half-frames, which keeps the muxer's caps stable.
    const audioQueue = buildLeakyQueue(bufferMs);
    // Audio-only output: alignment=1 (one TS packet per UDP datagram) rather
    // than 7. Packing 7 packets means waiting for ~40–160 ms of audio to
    // accumulate before each UDP send, which arrives at the downstream
    // decoder as bursts that exceed its late-tolerance budget and surface as
    // scratchy / dropped frames. Per-packet emission costs ~7× UDP overhead
    // but keeps timing smooth — on localhost / LAN the bandwidth hit is
    // irrelevant.
    return `${audioQueue} ! mpegtsmux name=mux_${suffix} latency=0 alignment=1 ! ${sink}`;
}

/**
 * Assemble the demuxer pipeline. Returns null when there is no upstream input
 * connection — caller should set a health warning.
 *
 * Pipeline shape:
 *   udpsrc ! tsdemux name=demux
 * No `tsparse` between `udpsrc` and `tsdemux` — see the inline comment for
 * why mid-pipeline PCR re-anchoring causes visible packet loss when the
 * stream is re-muxed downstream. The runner then attaches `linkOnPadAdded`
 * rules so each video/audio pad gets its own pre-built branch at runtime
 * (video: parser → queue → mpegtsmux → udpsink; audio: queue → mpegtsmux →
 * udpsink).
 */
export function buildPipeline(input: DemuxerPipelineInputs): DemuxerPipelineResult | null {
    const bufferMs = input.bufferMs ?? 50;
    // Goes straight `udpsrc ! tsdemux` with no `tsparse` in between: re-deriving
    // PTS from PCR mid-pipeline rewrites buffer running-times onto a separate
    // timeline, and downstream `mpegtsmux latency=0` re-emitting PCR from those
    // values surfaces at the receiver as visible packet loss on live video.
    const udpsrc = buildUdpSrc({
        host: input.input.host,
        port: input.input.port,
        caps: 'video/mpegts, systemstream=(boolean)true, packetsize=(int)188',
    });
    const pipeline = `${udpsrc} ! tsdemux latency=0 name=${DEMUX_NAME}`;

    const linkOnPadAdded: PadLinkRule[] = [];
    if (input.videoOutputs.length > 0) {
        linkOnPadAdded.push({
            from: DEMUX_NAME,
            media: 'video',
            branches: input.videoOutputs.map((o, i) =>
                buildOutputBranch(o, `v${i}`, 'video', bufferMs),
            ),
        });
    }
    if (input.audioOutputs.length > 0) {
        linkOnPadAdded.push({
            from: DEMUX_NAME,
            media: 'audio',
            branches: input.audioOutputs.map((o, i) =>
                buildOutputBranch(o, `a${i}`, 'audio', bufferMs),
            ),
        });
    }

    return { pipeline, linkOnPadAdded };
}

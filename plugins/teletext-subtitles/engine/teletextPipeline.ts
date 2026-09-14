/**
 * GStreamer pipeline for the teletext subtitle decoder.
 *
 *   bus TS ─ tsdemux ─ application/x-teletext ─ tee ┬ teletextdec page=888 ─ appsink ttxsink_0
 *                                                    └ teletextdec page=692 ─ appsink ttxsink_1
 *   appsrc subsrc_0 (KLV) ─ mpegtsmux ─ bus out 0
 *   appsrc subsrc_1 (KLV) ─ mpegtsmux ─ bus out 1
 *
 * subtitle-core's runner hook (`pay` entries) joins each appsink to its
 * appsrc: page text in, KLV-wrapped WebVTT cue out, stamped with house time.
 *
 * `teletextdec` decodes ONE page per instance, so the teletext ES is tee'd to
 * one decoder per configured page — decode cost is text, negligible. The
 * capsfilter directly on the tsdemux src selects the teletext elementary
 * stream (tsdemux exposes it as `application/x-teletext` when the PMT carries
 * the DVB teletext descriptor) and leaves video/audio pads unlinked, exactly
 * as the video transcoder selects `video/x-h264`. `subtitles-mode` strips the
 * page header and blank rows; the template with a REAL newline replaces the
 * element's default, which prints a literal backslash-n.
 */

import { buildTsUdpInput } from '@media-router/engine';
import {
    buildSubtitlePayTail,
    subtitleStreamPid,
    type SubtitlePayRunnerConfig,
} from '@media-router/plugin-subtitle-core';
import { pageLabel, type TeletextPage } from './teletextPorts.js';

export const DEMUX_NAME = 'demux';

export interface TeletextOutput {
    portId: string;
    /** Bus channel this page publishes on. */
    port: number;
    page: TeletextPage;
}

export interface TeletextPipelineInputs {
    input: { port: number; socketPath?: string };
    outputs: TeletextOutput[];
    /** Longest a cue stays up without a clear from the source (ms). */
    cueHoldMs: number;
}

export interface TeletextPipelineResult {
    pipeline: string;
    /** Bridge `pay` entries, one per output (→ subtitleRunnerHook). */
    subtitlePay: SubtitlePayRunnerConfig[];
    /** Bus-egress tee names (`busout_<port>`), for throughput polling. */
    sinkNames: string[];
}

export function appsinkName(index: number): string {
    return `ttxsink_${index}`;
}

export function appsrcName(index: number): string {
    return `subsrc_${index}`;
}

export function buildPipeline(input: TeletextPipelineInputs): TeletextPipelineResult | null {
    if (input.outputs.length === 0) return null;

    const tsInput = buildTsUdpInput({
        port: input.input.port,
        socketPath: input.input.socketPath,
        jitterMs: 200,
    });

    const decoders = input.outputs
        .map(
            (o, i) =>
                `t. ! queue ! teletextdec name=ttx_${i} page=${o.page.page} subtitles-mode=true ` +
                `subtitles-template="%s\n" ! text/x-raw,format=utf-8 ! appsink name=${appsinkName(i)}`,
        )
        .join(' ');

    const tails = input.outputs
        .map((o, i) =>
            buildSubtitlePayTail({
                appsrcName: appsrcName(i),
                muxName: `mux_${i}`,
                pid: subtitleStreamPid(i),
                port: o.port,
            }),
        )
        .join(' ');

    const pipeline =
        `${tsInput} ! tsdemux name=${DEMUX_NAME} latency=0 ! capsfilter caps="application/x-teletext" ! tee name=t ` +
        `${decoders} ${tails}`;

    return {
        pipeline,
        subtitlePay: input.outputs.map((o, i) => ({
            appsink: appsinkName(i),
            appsrc: appsrcName(i),
            holdMs: input.cueHoldMs,
            label: pageLabel(o.page),
        })),
        sinkNames: input.outputs.map((o) => `busout_${o.port}`),
    };
}

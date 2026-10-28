/**
 * GStreamer pipeline for the teletext subtitle decoder.
 *
 *   bus TS ─ tee in_t ┬ mrtsdemux ─ application/x-teletext ─ tee ┬ teletextdec page=888 ─ appsink ttxsink_0
 *                     │                                          └ teletextdec page=692 ─ appsink ttxsink_1
 *                     └ leaky queue ─ appsink tsprobe   (engine tsProbe → `tsprobe:pmt`)
 *   appsrc subsrc_0 (cue TS, packed by the bridge) ─ bus out 0
 *   appsrc subsrc_1 (cue TS, packed by the bridge) ─ bus out 1
 *
 * subtitle-core's runner hook (`pay` entries) joins each appsink to its
 * appsrc: page text in, KLV-wrapped WebVTT cue out, stamped with the page's
 * content time: teletextdec's text carries the PTS the formula demux gives the
 * teletext PES, its PES time on the house timeline (house-clock WI-P3-8).
 *
 * `teletextdec` decodes ONE page per instance, so the teletext ES is tee'd to
 * one decoder per configured page — decode cost is text, negligible. The demux
 * reassembles the private streams alone (`media=private`: no video/audio pad),
 * and the capsfilter directly on its src selects the teletext one (exposed as
 * `application/x-teletext` when the PMT carries the DVB teletext descriptor),
 * leaving any other private pad unlinked. `subtitles-mode` strips the
 * page header and blank rows; the template with a REAL newline replaces the
 * element's default, which prints a literal backslash-n.
 *
 * The `tsprobe` tap feeds the engine's report-only TS probe, whose PMT event
 * carries the teletext descriptor the module turns into the detected-page
 * list. With NO pages selected the pipeline is the tap alone, so a freshly
 * wired module still learns what the stream announces.
 */

import { buildTsUdpInput } from '@media-router/engine';
import {
    buildSubtitlePayTail,
    subtitleStreamPid,
    type SubtitlePayRunnerConfig,
} from '@media-router/plugin-subtitle-core';
import { pageLabel, type TeletextPage } from './teletextPorts.js';

const DEMUX_NAME = 'demux';
export const PROBE_SINK_NAME = 'tsprobe';

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

export function buildPipeline(input: TeletextPipelineInputs): TeletextPipelineResult {
    const tsInput = buildTsUdpInput({
        port: input.input.port,
        socketPath: input.input.socketPath,
        jitterMs: 200,
    });
    // Leaky: a report-only tap must shed, never back-pressure the demux branch.
    const probeTap = `queue leaky=downstream max-size-buffers=64 ! appsink name=${PROBE_SINK_NAME}`;

    if (input.outputs.length === 0) {
        return { pipeline: `${tsInput} ! ${probeTap}`, subtitlePay: [], sinkNames: [] };
    }

    const decoders = input.outputs
        .map(
            (o, i) =>
                `t. ! queue ! teletextdec name=ttx_${i} page=${o.page.page} subtitles-mode=true ` +
                `subtitles-template="%s\n" ! text/x-raw,format=utf-8 ! appsink name=${appsinkName(i)}`,
        )
        .join(' ');

    const tails = input.outputs
        .map((o, i) => buildSubtitlePayTail({ appsrcName: appsrcName(i), port: o.port }))
        .join(' ');

    const pipeline =
        `${tsInput} ! tee name=in_t ! queue ! mrtsdemux name=${DEMUX_NAME} media=private ` +
        `! capsfilter caps="application/x-teletext" ! tee name=t ` +
        `${decoders} ${tails} in_t. ! ${probeTap}`;

    return {
        pipeline,
        subtitlePay: input.outputs.map((o, i) => ({
            appsink: appsinkName(i),
            appsrc: appsrcName(i),
            pid: subtitleStreamPid(i),
            holdMs: input.cueHoldMs,
            label: pageLabel(o.page),
        })),
        sinkNames: input.outputs.map((o) => `busout_${o.port}`),
    };
}

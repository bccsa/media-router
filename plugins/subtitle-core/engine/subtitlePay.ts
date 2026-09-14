/**
 * Producer half of the carrier: the pipeline tail that turns KLV cue buffers
 * into a single-program MPEG-TS on the bus.
 *
 *     appsrc (meta/x-klv) ! mpegtsmux ! <bus sink>
 *
 * The runner's subtitle bridge pushes one KLV buffer per cue into the appsrc
 * (stamped with house time — running-time ≡ house time on a contract
 * pipeline, so the mux's PES PTS carry the cue start directly). The KLV PID
 * is the only elementary stream, so it also carries the PCR: `mpegtsmux`
 * wants an explicit program map for that, same shape the mpegts-muxer uses
 * for its metadata carousel.
 *
 * `is-live=false` on the appsrc for the same reason the muxer's carousel is:
 * a live appsrc pad enters the aggregator's latency arithmetic and, with no
 * media pad to bound it, floods the bus with "Impossible to configure
 * latency" warnings. `format=time` + explicit PTS on every push.
 */

import { buildBusSink, muxSinkPadName } from '@media-router/engine';

export interface SubtitlePayTailOpts {
    /** `name=` of the appsrc the bridge pushes cues into. */
    appsrcName: string;
    /** `name=` of the mpegtsmux (unique per pipeline). */
    muxName: string;
    /** TS PID of the subtitle stream (subtitleStreamPid(i)). */
    pid: number;
    /** Bus channel this output publishes on. */
    port: number;
}

export function buildSubtitlePayTail(opts: SubtitlePayTailOpts): string {
    const pad = muxSinkPadName(opts.pid);
    return (
        `appsrc name=${opts.appsrcName} is-live=false format=time block=false ` +
        `caps="meta/x-klv,parsed=true" ! ${opts.muxName}.${pad} ` +
        `mpegtsmux name=${opts.muxName} alignment=7 ` +
        `prog-map="program_map,${pad}=(int)1,PCR_1=${pad}" ! ${buildBusSink(opts.port)}`
    );
}

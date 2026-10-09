/**
 * Producer half of the carrier: the pipeline tail that puts a subtitle
 * stream's MPEG-TS on the bus.
 *
 *     appsrc (video/mpegts) ! <bus sink>
 *
 * The runner's subtitle bridge packs each cue itself (`py/subtitle_pack.py`:
 * PAT, PMT with the KLVA registration and the PCR on the KLV PID, one PES at
 * cue start + 1 h — the layout mpegtsmux wrote) and pushes it as ONE buffer
 * with PTS = the cue's content time. No mpegtsmux: on the OCC gate its
 * aggregator held each sparse cue until up to two later pushes arrived
 * (2026-10-09, egress trace mux=+2–6 s), so it is out of the path.
 *
 * `is-live=false`: the appsrc must not enter the pipeline's latency
 * arithmetic; `format=time` + explicit PTS on every push.
 */

import { buildBusSink, BUS_TS_CAPS } from '@media-router/engine';

export interface SubtitlePayTailOpts {
    /** `name=` of the appsrc the bridge pushes cue TS into. */
    appsrcName: string;
    /** Bus channel this output publishes on. */
    port: number;
}

export function buildSubtitlePayTail(opts: SubtitlePayTailOpts): string {
    return (
        `appsrc name=${opts.appsrcName} is-live=false format=time block=false ` +
        `caps="${BUS_TS_CAPS}" ! ${buildBusSink(opts.port)}`
    );
}

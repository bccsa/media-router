import { describe, it, expect } from 'vitest';
import { buildPipeline } from './teletextPipeline.js';

const outputs = [
    { portId: 'page-0', port: 40300, page: { page: 888, language: 'eng', name: '' } },
    { portId: 'page-1', port: 40301, page: { page: 692, language: 'nor', name: 'Norsk' } },
];

describe('teletext pipeline', () => {
    it('returns null with no outputs', () => {
        expect(buildPipeline({ input: { port: 5004 }, outputs: [], cueHoldMs: 8000 })).toBeNull();
    });

    it('decodes the teletext ES once and fans it to one decoder per page', () => {
        const r = buildPipeline({
            input: { port: 5004, socketPath: '/run/edge.sock' },
            outputs,
            cueHoldMs: 8000,
        })!;
        const p = r.pipeline;
        expect(p).toMatch(/^unixfdsrc /);
        expect(p).toContain('/run/edge.sock');
        expect(p).toContain(
            '! tsdemux name=demux latency=0 ! capsfilter caps="application/x-teletext" ! tee name=t ',
        );
        expect(p).toContain(
            't. ! queue ! teletextdec name=ttx_0 page=888 subtitles-mode=true subtitles-template="%s\n" ! text/x-raw,format=utf-8 ! appsink name=ttxsink_0',
        );
        expect(p).toContain('teletextdec name=ttx_1 page=692');
        // one KLV appsrc + mux + bus egress per page, on the subtitle PID range
        expect(p).toContain(
            'appsrc name=subsrc_0 is-live=false format=time block=false caps="meta/x-klv,parsed=true" ! mux_0.sink_384',
        );
        expect(p).toContain(
            'mpegtsmux name=mux_1 alignment=7 prog-map="program_map,sink_385=(int)1,PCR_1=sink_385"',
        );
        expect(p).toContain('tee name=busout_40300 allow-not-linked=true');
        expect(p).toContain('tee name=busout_40301 allow-not-linked=true');
        // the pipeline string must never re-stamp bus timing (time-sync contract)
        expect(p).not.toContain('set-timestamps=true');
        expect(p).not.toContain('do-timestamp=true');
    });

    it('describes each appsink→appsrc pair for the runner bridge', () => {
        const r = buildPipeline({ input: { port: 5004 }, outputs, cueHoldMs: 4500 })!;
        expect(r.subtitlePay).toEqual([
            { appsink: 'ttxsink_0', appsrc: 'subsrc_0', holdMs: 4500, label: 'eng 888' },
            { appsink: 'ttxsink_1', appsrc: 'subsrc_1', holdMs: 4500, label: 'Norsk' },
        ]);
        expect(r.sinkNames).toEqual(['busout_40300', 'busout_40301']);
    });
});

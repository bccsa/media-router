import { describe, it, expect } from 'vitest';
import { muxTimingProps } from './muxTiming.js';
import { buildPipeline } from './mpegtsMuxerPipeline.js';

const muxElement = (pipeline: string) => pipeline.slice(0, pipeline.indexOf(' ! '));

describe('muxTimingProps', () => {
    it('under the contract: no latency budget, no packet grouping, a PCR on every frame', () => {
        expect(muxTimingProps(true, 7)).toBe('latency=0 alignment=0 pcr-interval=1800');
        // The operator's alignment cannot bring the hold back.
        expect(muxTimingProps(true, 1)).toBe('latency=0 alignment=0 pcr-interval=1800');
    });
    it('off-contract: the 2026-07-16 budget and the operator alignment, byte for byte', () => {
        expect(muxTimingProps(false, 7)).toBe(
            'latency=1200000000 min-upstream-latency=1200000000 alignment=7',
        );
        expect(muxTimingProps(false, 0)).toBe(
            'latency=1200000000 min-upstream-latency=1200000000 alignment=0',
        );
    });
});

describe('buildPipeline mux timing', () => {
    const sources = [
        { sinkPortId: 'input-0', port: 40001, pid: 250 },
        { sinkPortId: 'input-1', port: 40002, pid: 251 },
    ];
    const output = { port: 40010 };
    const progMap = 'prog-map="program_map,sink_250=(int)1,sink_251=(int)1,PCR_1=sink_250"';

    it('the contract muxer waits for nothing, whatever alignment is stored (.21 stores 7)', () => {
        const p = buildPipeline({ sources, output, alignment: 7, timeSyncContract: true })!;
        expect(muxElement(p.pipeline)).toBe(
            `mpegtsmux name=mux latency=0 alignment=0 pcr-interval=1800 ${progMap}`,
        );
    });
    it('keeps the legacy element string unchanged with the contract off or unset', () => {
        const legacy =
            'mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000' +
            ` alignment=7 ${progMap}`;
        const off = buildPipeline({ sources, output, alignment: 7, timeSyncContract: false })!;
        expect(muxElement(off.pipeline)).toBe(legacy);
        expect(muxElement(buildPipeline({ sources, output, alignment: 7 })!.pipeline)).toBe(legacy);
    });
});

import { describe, it, expect } from 'vitest';
import type { ModuleTimingSummary } from '@media-router/shared-types';
import { timingChanged, timingPublication } from './timingSections.js';

const lat = (meanMs: number, minMs = meanMs, maxMs = meanMs) => ({ meanMs, minMs, maxMs });
/** An input as LatenessReporter reports it: label from the tap, `addedMs` = output − input. */
const input = (tap: string, meanMs: number, outMs?: number) => ({
    tap,
    label: tap.slice(4),
    lateness: lat(meanMs),
    ...(outMs !== undefined ? { addedMs: outMs - meanMs } : {}),
});
/** A bus output as LatenessReporter lists it, with two or more. */
const output = (port: number, meanMs: number, minMs = meanMs, maxMs = meanMs) => ({
    tap: `lat_busout_${port}`,
    port: String(port),
    lateness: lat(meanMs, minMs, maxMs),
});

describe('timingPublication', () => {
    it('single-input transform: output, its range and added latency = out − in', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(88, 80, 95),
            inputs: [input('lat_busin', 40, 88)],
        };
        expect(timingPublication(s).data.timing).toMatchObject({
            outputMs: 88,
            outputRange: '80 – 95',
            addedMs: 48,
        });
    });

    it('a 3-input muxer: added latency against the slowest input, one section per input', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(300),
            inputs: [
                input('lat_busin_0', 20, 300),
                input('lat_busin_1', 140, 300),
                input('lat_busin_2', 65, 300),
            ],
            slowest: 'busin_1',
        };
        const pub = timingPublication(s);
        // Added latency in the main section is against the input it waits for.
        expect(pub.data.timing).toMatchObject({ addedMs: 160, slowest: 'busin_1' });
        expect(pub.sections.map((x) => x.id)).toEqual([
            'timing',
            'timing-in-1',
            'timing-in-2',
            'timing-in-3',
        ]);
        expect(pub.data['timing-in-2']).toMatchObject({ latenessMs: 140, addedMs: 160 });
    });

    it('the badge is the render lateness in ms, grey: no threshold (OQ-8)', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(20),
            inputs: [input('lat_busin_41000_abcdef', 5, 20)],
            decodeMs: 15,
            presentationDelayMs: 60,
            deviceLatencyMs: 100,
            renderMs: 160,
        };
        expect(timingPublication(s).badge).toEqual({
            id: 'lateness',
            icon: 'timer',
            text: '160 ms',
            color: '#6b7280',
        });
    });

    it('every row carries a label and every number a unit', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(20),
            inputs: [input('lat_busin_0', 5, 20), input('lat_busin_1', 9, 20)],
            slowest: 'busin_1',
            decodeMs: 11,
            presentationDelayMs: 60,
            deviceLatencyMs: 100,
            renderMs: 160,
            pipeWireLatencyMs: 21.3,
            processingLatencyMs: 5.2,
        };
        const pub = timingPublication(s);
        const timing = pub.sections.find((x) => x.id === 'timing')!;
        expect(timing.fields.map((f) => f.label)).toEqual([
            'Output lateness',
            'Output lateness min – max',
            'Added latency',
            'Processing latency',
            'Slowest input',
            'Decode',
            'Presentation delay',
            'Device latency',
            'Render lateness',
            'PipeWire latency',
        ]);
        for (const sec of pub.sections) {
            for (const f of sec.fields) {
                expect(f.label.length).toBeGreaterThan(0);
                const v = pub.data[sec.id][f.key];
                if (typeof v === 'number' || f.key.endsWith('Range')) expect(f.unit).toBe('ms');
            }
        }
    });

    it("a processing latency (a limiter's lookahead, OQ-22) is its own row, in ms", () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(30),
            inputs: [input('lat_busin', 10, 30)],
            processingLatencyMs: 5.2,
        };
        expect(timingPublication(s).data.timing).toEqual({
            outputMs: 30,
            outputRange: '30 – 30',
            addedMs: 20,
            processingLatencyMs: 5,
        });
        expect(timingChanged(s, { ...s, processingLatencyMs: 5.8 })).toBe(false);
        expect(timingChanged(s, { ...s, processingLatencyMs: 6.3 })).toBe(true);
        expect(timingChanged(s, { ...s, processingLatencyMs: undefined })).toBe(true);
    });

    it('says the instrument is missing instead of showing nothing', () => {
        expect(timingPublication({ inputs: [], instrument: false }).data.timing).toEqual({
            instrument: 'lateness instrument missing',
        });
    });

    it('two or more bus outputs: one section each after the inputs, the rest as with one', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(109, 60, 140),
            outputs: [output(41000, 129, 120, 140), output(41001, 69, 60, 80)],
            inputs: [input('lat_busin', 100, 109)],
        };
        const pub = timingPublication(s);
        expect(pub.sections.map((x) => [x.id, x.label])).toEqual([
            ['timing', 'Timing'],
            ['timing-in-1', 'Input 1 timing: busin'],
            ['timing-out-1', 'Output 1 timing: 41000'],
            ['timing-out-2', 'Output 2 timing: 41001'],
        ]);
        expect(pub.sections[2].fields).toEqual([
            { key: 'latenessMs', label: 'Lateness', unit: 'ms' },
            { key: 'latenessRange', label: 'Lateness min – max', unit: 'ms' },
        ]);
        expect(pub.data['timing-out-1']).toEqual({ latenessMs: 129, latenessRange: '120 – 140' });
        expect(pub.data['timing-out-2']).toEqual({ latenessMs: 69, latenessRange: '60 – 80' });
        // The merged output, added latency and badge are what one output would show.
        expect(pub.data.timing).toEqual({ outputMs: 109, outputRange: '60 – 140', addedMs: 9 });
        const one = timingPublication({ ...s, outputs: undefined });
        expect(pub.sections.slice(0, 2)).toEqual(one.sections);
        expect(Object.keys(one.data)).toEqual(['timing', 'timing-in-1']);
        expect(pub.data).toMatchObject(one.data);
        expect(pub.badge).toEqual(one.badge);
    });
});

describe('timingChanged (R-P0-6)', () => {
    it('a change below 1 ms is not a change; 1 ms or a new row is', () => {
        const a: ModuleTimingSummary = { instrument: true, inputs: [input('lat_busin', 40)] };
        expect(timingChanged(a, { instrument: true, inputs: [input('lat_busin', 40.6)] })).toBe(
            false,
        );
        expect(timingChanged(a, { instrument: true, inputs: [input('lat_busin', 41.2)] })).toBe(
            true,
        );
        expect(
            timingChanged(a, {
                instrument: true,
                output: lat(50),
                inputs: [input('lat_busin', 40, 50)],
            }),
        ).toBe(true);
    });

    it('a per-output row moving 1 ms is a change, though the merged output holds', () => {
        const outs = (...o: ReturnType<typeof output>[]): ModuleTimingSummary => ({
            instrument: true,
            output: lat(100),
            outputs: o,
            inputs: [],
        });
        const a = outs(output(41000, 129, 120), output(41001, 69));
        expect(timingChanged(a, outs(output(41000, 129.6, 120.4), output(41001, 68.5)))).toBe(
            false,
        );
        expect(timingChanged(a, outs(output(41000, 129, 120), output(41001, 70)))).toBe(true);
        expect(timingChanged(a, outs(output(41000, 129, 119), output(41001, 69)))).toBe(true);
        // The list coming or going (a second output, or one left) is a change too.
        const merged: ModuleTimingSummary = { instrument: true, output: lat(100), inputs: [] };
        expect(timingChanged(merged, a)).toBe(true);
        expect(timingChanged(a, merged)).toBe(true);
    });
});

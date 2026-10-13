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
        };
        const pub = timingPublication(s);
        const timing = pub.sections.find((x) => x.id === 'timing')!;
        expect(timing.fields.map((f) => f.label)).toEqual([
            'Output lateness',
            'Output lateness min – max',
            'Added latency',
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

    it('says the instrument is missing instead of showing nothing', () => {
        expect(timingPublication({ inputs: [], instrument: false }).data.timing).toEqual({
            instrument: 'lateness instrument missing',
        });
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
});

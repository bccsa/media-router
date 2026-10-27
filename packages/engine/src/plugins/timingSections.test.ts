import { describe, it, expect } from 'vitest';
import type { ModuleTimingSummary } from '@media-router/shared-types';
import { timingChanged, timingPublication } from './timingSections.js';

const lat = (meanMs: number, minMs = meanMs, maxMs = meanMs) => ({ meanMs, minMs, maxMs });
/** An input as LatenessReporter reports it: input `n`, label from the tap, `addedMs` = out − in. */
const input = (tap: string, meanMs: number, outMs?: number, n = 1) => ({
    tap,
    n,
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
                input('lat_busin_0', 20, 300, 1),
                input('lat_busin_1', 140, 300, 2),
                input('lat_busin_2', 65, 300, 3),
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

    it('an input section keeps its number when an earlier input goes dark: a gap, no renumber', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(300),
            inputs: [input('lat_busin_1', 140, 300, 2), input('lat_busin_2', 65, 300, 3)],
            slowest: 'busin_1',
        };
        const pub = timingPublication(s);
        expect(pub.sections.map((x) => [x.id, x.label])).toEqual([
            ['timing', 'Timing'],
            ['timing-in-2', 'Input 2 timing: busin_1'],
            ['timing-in-3', 'Input 3 timing: busin_2'],
        ]);
        expect(pub.data['timing-in-2']).toMatchObject({ latenessMs: 140 });
        expect(pub.data['timing-in-1']).toBeUndefined();
    });

    it('says when the device latency is a stand-in, and the number stays a number', () => {
        const s: ModuleTimingSummary = {
            instrument: true,
            output: lat(20),
            inputs: [],
            deviceLatencyMs: 1000 / 60,
            deviceLatencyNote: '60 Hz assumed',
            renderMs: 37,
        };
        const field = (sum: ModuleTimingSummary) =>
            timingPublication(sum).sections[0].fields.find((f) => f.key === 'deviceLatencyMs');
        expect(field(s)).toEqual({
            key: 'deviceLatencyMs',
            label: 'Device latency (60 Hz assumed)',
            unit: 'ms',
        });
        expect(timingPublication(s).data.timing.deviceLatencyMs).toBe(17);
        const known = { ...s, deviceLatencyMs: 20, deviceLatencyNote: undefined };
        expect(field(known)?.label).toBe('Device latency');
        expect(timingChanged(s, known)).toBe(true);
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
            inputs: [input('lat_busin_0', 5, 20, 1), input('lat_busin_1', 9, 20, 2)],
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
        // The same tap under another number moves its section: a change.
        expect(
            timingChanged(a, { instrument: true, inputs: [input('lat_busin', 40, undefined, 2)] }),
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

describe('timingPublication: aligner modules (WI-P2-13)', () => {
    /** An aligner input: its tap's window and what its watch reports. */
    const aligned = (
        tap: string,
        meanMs: number | undefined,
        state: 'waiting' | 'present' | 'absent',
        more: { silenceLimitMs?: number; absences?: number; staleMs?: number } = {},
    ) => ({
        tap,
        n: Number(tap.slice('lat_busin_'.length)) + 1,
        label: tap.replace(/^lat_/, ''),
        ...(meanMs !== undefined ? { lateness: lat(meanMs), addedMs: 300 - meanMs } : {}),
        state,
        silenceLimitMs: more.silenceLimitMs ?? 100,
        absences: more.absences ?? 0,
        staleMs: more.staleMs ?? 0,
    });
    const mixer: ModuleTimingSummary = {
        instrument: true,
        output: lat(300),
        inputs: [
            aligned('lat_busin_0', 20, 'present', { silenceLimitMs: 104.6 }),
            aligned('lat_busin_1', 140, 'present', { absences: 2, staleMs: 990.4 }),
        ],
        slowest: 'busin_1',
        paceMs: 120.4,
        waitingFor: 'busin_1',
    };

    it('Pace and Waiting for in the timing section (Waiting for replaces Slowest input)', () => {
        const pub = timingPublication(mixer);
        const timing = pub.sections.find((x) => x.id === 'timing')!;
        expect(timing.fields).toEqual([
            { key: 'outputMs', label: 'Output lateness', unit: 'ms' },
            { key: 'outputRange', label: 'Output lateness min – max', unit: 'ms' },
            { key: 'addedMs', label: 'Added latency', unit: 'ms' },
            { key: 'paceMs', label: 'Pace', unit: 'ms' },
            { key: 'waitingFor', label: 'Waiting for' },
        ]);
        expect(pub.data.timing).toEqual({
            outputMs: 300,
            outputRange: '300 – 300',
            addedMs: 160,
            paceMs: 120,
            waitingFor: 'busin_1',
        });
        // Without the aligners' answer P0's stand-in shows, as before.
        const p0 = timingPublication({ ...mixer, paceMs: undefined, waitingFor: undefined });
        expect(p0.data.timing).toMatchObject({ slowest: 'busin_1' });
        expect(p0.data.timing).not.toHaveProperty('waitingFor');
    });

    it('State, Silence limit, Absences and Discarded on rejoin per input, with units', () => {
        const pub = timingPublication(mixer);
        expect(pub.sections.find((x) => x.id === 'timing-in-2')!.fields).toEqual([
            { key: 'latenessMs', label: 'Lateness', unit: 'ms' },
            { key: 'latenessRange', label: 'Lateness min – max', unit: 'ms' },
            { key: 'addedMs', label: 'Added', unit: 'ms' },
            { key: 'state', label: 'State' },
            { key: 'silenceLimitMs', label: 'Silence limit', unit: 'ms' },
            { key: 'absences', label: 'Absences' },
            { key: 'staleMs', label: 'Discarded on rejoin', unit: 'ms' },
        ]);
        expect(pub.data['timing-in-1']).toMatchObject({ state: 'present', silenceLimitMs: 105 });
        expect(pub.data['timing-in-2']).toEqual({
            latenessMs: 140,
            latenessRange: '140 – 140',
            addedMs: 160,
            state: 'present',
            silenceLimitMs: 100,
            absences: 2,
            staleMs: 990,
        });
    });

    it('an input only its watch reports (a dark tap, or none): no lateness rows', () => {
        const pub = timingPublication({
            instrument: true,
            output: lat(300),
            inputs: [
                aligned('lat_busin_0', undefined, 'absent', { silenceLimitMs: 300, absences: 1 }),
                aligned('lat_busin_1', 20, 'present'),
            ],
            waitingFor: 'busin_0',
        });
        expect(pub.data['timing-in-1']).toEqual({
            state: 'absent',
            silenceLimitMs: 300,
            absences: 1,
            staleMs: 0,
        });
        // Added latency is read off an input that has a tap.
        expect(pub.data.timing).toMatchObject({ addedMs: 280 });
    });

    it('every number carries its unit; a count none', () => {
        const pub = timingPublication(mixer);
        for (const sec of pub.sections) {
            for (const f of sec.fields) {
                const v = pub.data[sec.id][f.key];
                if (f.key === 'absences') expect(f.unit).toBeUndefined();
                else if (typeof v === 'number') expect(f.unit).toBe('ms');
            }
        }
    });

    it('timingChanged: a state, a waited-for input or one more absence is a change', () => {
        const moved = (patch: Partial<ReturnType<typeof aligned>>, top = {}) => ({
            ...mixer,
            ...top,
            inputs: [mixer.inputs[0], { ...mixer.inputs[1], ...patch }],
        });
        expect(timingChanged(mixer, moved({ state: 'absent' }))).toBe(true);
        expect(timingChanged(mixer, moved({ absences: 3 }))).toBe(true);
        expect(timingChanged(mixer, moved({ silenceLimitMs: 100.6 }))).toBe(false);
        expect(timingChanged(mixer, moved({ silenceLimitMs: 101.2 }))).toBe(true);
        expect(timingChanged(mixer, moved({ staleMs: 990.9 }))).toBe(false);
        expect(timingChanged(mixer, moved({ staleMs: 1000 }))).toBe(true);
        expect(timingChanged(mixer, moved({}, { waitingFor: 'busin_0' }))).toBe(true);
        expect(timingChanged(mixer, moved({}, { paceMs: 120.9 }))).toBe(false);
        expect(timingChanged(mixer, moved({}, { paceMs: 121.5 }))).toBe(true);
        expect(timingChanged(mixer, moved({}, { paceMs: undefined }))).toBe(true);
        // A row coming or going is a change: the watch's fields alone, too.
        const { state: _s, ...noState } = mixer.inputs[1];
        expect(timingChanged(mixer, { ...mixer, inputs: [mixer.inputs[0], noState] })).toBe(true);
    });
});

describe('timingPublication: demux and ASRC rows (WI-P3-6)', () => {
    const demux = { pesPerS: 46.875, gaps: 2, ccLost: 14, unknownStreams: 1 };
    const s: ModuleTimingSummary = {
        instrument: true,
        output: lat(40),
        inputs: [
            { ...input('lat_busin_0', 20, 40, 1), demux, clockCorrection: { sourcePpm: 23.44 } },
            { ...input('lat_busin_1', 22, 40, 2), clockCorrection: {} },
        ],
        clockCorrection: { sourcePpm: -0.31 },
        deviceClockPpm: -12.1,
    };

    it('each input: its Demux rows and its clock correction, signed, the source named', () => {
        const pub = timingPublication(s);
        expect(pub.data['timing-in-1']).toMatchObject({
            demuxPesPerS: 47,
            demuxGaps: 2,
            demuxCcLost: 14,
            demuxUnknownStreams: 1,
            clockCorrection: '+23.4 ppm (source)',
        });
        expect(pub.data['timing-in-2']).toMatchObject({ clockCorrection: 'none (house rate)' });
        expect(pub.data['timing-in-2'].demuxGaps).toBeUndefined();
        const in1 = pub.sections.find((x) => x.id === 'timing-in-1')!;
        expect(in1.fields.slice(-5)).toEqual([
            { key: 'demuxPesPerS', label: 'Demux rate', unit: 'PES/s' },
            { key: 'demuxGaps', label: 'Demux gaps' },
            { key: 'demuxCcLost', label: 'Demux CC lost', unit: 'packets' },
            { key: 'demuxUnknownStreams', label: 'Demux unknown streams' },
            { key: 'clockCorrection', label: 'Clock correction' },
        ]);
    });

    it("the module's own ASRC and the device clock in the timing section", () => {
        const pub = timingPublication(s);
        expect(pub.data.timing).toMatchObject({
            clockCorrection: '−0.3 ppm (source)',
            deviceClock: '−12.1 ppm',
        });
        expect(timingPublication({ ...s, deviceClockPpm: 40 }).data.timing.deviceClock).toBe(
            '+40.0 ppm',
        );
    });

    it('timingChanged: 0.1 ppm, an engage, a PES/s or a counter is a change; less is not', () => {
        const at = (patch: Partial<ModuleTimingSummary>, in0: object = {}) => ({
            ...s,
            ...patch,
            inputs: [{ ...s.inputs[0], ...in0 }, s.inputs[1]],
        });
        expect(timingChanged(s, at({ deviceClockPpm: -12.15 }))).toBe(false);
        expect(timingChanged(s, at({ deviceClockPpm: -12.2 }))).toBe(true);
        expect(timingChanged(s, at({ clockCorrection: {} }))).toBe(true);
        expect(timingChanged(s, at({}, { clockCorrection: { sourcePpm: 23.5 } }))).toBe(false);
        expect(timingChanged(s, at({}, { clockCorrection: { sourcePpm: 23.6 } }))).toBe(true);
        expect(timingChanged(s, at({}, { demux: { ...demux, pesPerS: 47.5 } }))).toBe(false);
        expect(timingChanged(s, at({}, { demux: { ...demux, pesPerS: 48 } }))).toBe(true);
        expect(timingChanged(s, at({}, { demux: { ...demux, ccLost: 15 } }))).toBe(true);
        expect(timingChanged(s, at({}, { demux: undefined }))).toBe(true);
    });
});

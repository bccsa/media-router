import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LatenessReporter } from './latenessReporter.js';
import { timingPublication } from './timingSections.js';
import { buildAsrc } from './ingestTiming.js';
import { DEVICE_STALLED_TEXT } from './asrcWatches.js';
import { DISPLAY_NOT_PRESENTING_TEXT } from './videoPaceWatches.js';

// Lateness at outputs (WI-P4-12): the presentation's own render lateness, device latency, the
// video pace's rows, the device term's counts, the trend, and the two presentation warnings.
const MS = 1_000_000;
const win = (meanMs: number) => ({
    count: 100,
    'min-ns': meanMs * MS,
    'mean-ns': meanMs * MS,
    'max-ns': meanMs * MS,
});
const pace = (o: Record<string, number | string | boolean> = {}) => ({
    released: 500,
    late: 0,
    'rate-drops': 0,
    'gaps-collapsed': 0,
    'content-fps-x100': 5000,
    'refresh-ns': 20_000_000,
    'refresh-source': 'measured',
    'achieved-ns': 0,
    'display-behind': 0,
    'mean-hold-ns': 12_000_000,
    'present-lateness-ns': 240_000_000,
    'display-presenting': true,
    ...o,
});
const asrcStats = (o: Record<string, number | string | boolean> = {}) => ({
    state: 'locked',
    relocks: 0,
    'in-frames': 96_000,
    mode: 'device',
    'source-ppb': 0,
    'device-ppb': -135_000,
    'device-relocks': 1,
    'device-stalls': 0,
    'render-lateness-ns': 182_000_000,
    gaps: 0,
    ...o,
});
const OUT = buildAsrc({ name: 'outasrc', deviceSink: 'sink' });

function video(): LatenessReporter {
    const r = new LatenessReporter();
    r.onEvent('mrlateness:lat_busin', win(100), 0);
    r.onEvent('mrlateness:lat_render', win(215), 0);
    return r;
}

function audio(): LatenessReporter {
    const r = new LatenessReporter();
    r.configure(`audiotestsrc ! ${OUT} ! fakesink`);
    r.onEvent('mrlateness:lat_busin', win(40), 0);
    r.onEvent('mrlateness:lat_render', win(60), 0);
    r.setDeviceStandIn({ deviceLatencyMs: 100 });
    return r;
}

const labels = (r: LatenessReporter, now: number) =>
    timingPublication(r.summary(now)).sections[0].fields.map((f) => f.label);

describe('LatenessReporter at outputs', () => {
    it("video: mrvideopace's presented lateness is the render lateness, device latency what it adds", () => {
        const r = video();
        r.onEvent('mrvideopace:vp_pace', pace(), 0);
        const s = r.summary(0);
        expect(s).toMatchObject({
            decodeMs: 115,
            renderMs: 240,
            deviceLatencyMs: 25,
            rateMatch: { contentFps: 50, displayHz: 50, displaySource: 'measured', dropsPerMin: 0 },
            lateReleasesPerMin: 0,
            paceHoldMs: 12,
            latenessTrend: {},
        });
        const pub = timingPublication(s);
        expect(pub.data.timing).toMatchObject({
            renderMs: 240,
            rateMatch: '50.00 fps → 50.00 Hz measured, 0 drops/min',
            lateReleases: 0,
            paceHoldMs: 12,
            latenessTrend: 'measuring',
        });
        expect(labels(r, 0)).toEqual([
            'Output lateness',
            'Output lateness min – max',
            'Added latency',
            'Decode',
            'Device latency',
            'Render lateness',
            'Lateness trend',
            'Rate match',
            'Late releases',
            'Pace hold',
        ]);
        expect(pub.sections[0].fields.find((f) => f.key === 'lateReleases')!.unit).toBe('/min');
        expect(pub.badge!.text).toBe('240 ms');
    });

    it('video before its first release: λ(render) + one refresh, the stand-in noted', () => {
        const r = video();
        r.setDeviceStandIn({ deviceLatencyMs: 1000 / 60, deviceLatencyNote: '60 Hz assumed' });
        r.onEvent('mrvideopace:vp_pace', pace({ released: 0 }), 0);
        expect(r.summary(0)).toMatchObject({
            renderMs: 215 + 1000 / 60,
            deviceLatencyMs: 1000 / 60,
            deviceLatencyNote: '60 Hz assumed',
        });
    });

    it("audio: mrasrc's render lateness, device latency past λ(render), device relocks and stalls on the clock rows", () => {
        const r = audio();
        // Before the term knows it: λ(render) + the ring.
        r.onEvent('mrasrc-stats:outasrc', asrcStats({ 'render-lateness-ns': 0 }), 0);
        expect(r.summary(0)).toMatchObject({ renderMs: 160, deviceLatencyMs: 100 });
        r.onEvent('mrasrc-stats:outasrc', asrcStats(), 2_000);
        const s = r.summary(2_000);
        expect(s).toMatchObject({
            renderMs: 182,
            deviceLatencyMs: 122,
            deviceClockPpm: -135,
            deviceRelocks: 1,
            deviceStalls: 0,
        });
        expect(s.deviceLatencyNote).toBeUndefined();
        expect(s.rateMatch).toBeUndefined();
        expect(labels(r, 2_000)).toEqual([
            'Output lateness',
            'Output lateness min – max',
            'Added latency',
            'Decode',
            'Device latency',
            'Render lateness',
            'Lateness trend',
            'Device clock',
            'Device relocks',
            'Device stalls',
        ]);
    });

    it('no output shows a presentation delay, and the summary has no D', () => {
        for (const r of [video(), audio()]) {
            r.onEvent('mrvideopace:vp_pace', pace(), 0);
            r.onEvent('mrasrc-stats:outasrc', asrcStats(), 0);
            const s = r.summary(0);
            expect(s).not.toHaveProperty('presentationDelayMs');
            expect(JSON.stringify(timingPublication(s))).not.toMatch(/[Pp]resentation delay/);
        }
    });

    it('device stalled: warned from device-stalled until device-resumed', () => {
        const r = audio();
        r.onEvent('mrasrc-stats:outasrc', asrcStats(), 0);
        expect(
            r.onStream('mrasrc-event:outasrc', { kind: 'device-stalled', reason: '' }, 0)!.changed,
        ).toBe(true);
        expect(r.streamWarnings(0)).toEqual([
            { kind: 'device-stalled', text: DEVICE_STALLED_TEXT },
        ]);
        r.onEvent('mrasrc-stats:outasrc', asrcStats({ 'device-stalls': 1 }), 2_000);
        expect(r.streamWarnings(2_000)).toHaveLength(1);
        expect(r.summary(2_000).deviceStalls).toBe(1);
        r.onStream('mrasrc-event:outasrc', { kind: 'device-resumed', reason: '' }, 3_000);
        expect(r.streamWarnings(3_000)).toEqual([]);
    });

    it('display not presenting: warned while it lasts, cleared when it presents again or the pace goes', () => {
        const r = video();
        const stopped = r.onStream(
            'mrvideopace:vp_pace',
            pace({ 'display-presenting': false }),
            0,
        )!;
        expect(stopped.changed).toBe(true);
        expect(stopped.events).toEqual([{ source: 'display', name: 'vp_pace', presenting: false }]);
        expect(r.streamWarnings(0)).toEqual([
            { kind: 'display-not-presenting', text: DISPLAY_NOT_PRESENTING_TEXT },
        ]);
        const back = r.onStream('mrvideopace:vp_pace', pace(), 2_000)!;
        expect(back.events).toEqual([{ source: 'display', name: 'vp_pace', presenting: true }]);
        expect(r.streamWarnings(2_000)).toEqual([]);
        r.onEvent('mrvideopace:vp_pace', pace({ 'display-presenting': false }), 4_000);
        expect(r.streamWarnings(4_000)).toHaveLength(1);
        expect(r.streamWarnings(10_001)).toEqual([]);
    });

    it('the trend: a render lateness rising 12 ms/min for 3 min reads +12, labelled', () => {
        const r = video();
        for (let at = 0; at <= 180_000; at += 2_000) {
            r.onEvent('mrlateness:lat_render', win(215), at);
            const ns = (240 + (12 * at) / 60_000) * MS;
            r.onEvent('mrvideopace:vp_pace', pace({ 'present-lateness-ns': ns }), at);
            if (at < 180_000) expect(r.summary(at).latenessTrend).toEqual({});
        }
        const s = r.summary(180_000);
        expect(s.latenessTrend!.msPerMin).toBeCloseTo(12, 6);
        expect(timingPublication(s).data.timing.latenessTrend).toBe(
            '+12 ms/min — decode or device slower than real time',
        );
    });

    it('the trend never spans a gap the pace collapsed: it measures afresh', () => {
        const r = video();
        let gaps = 0;
        for (let at = 0; at <= 300_000; at += 2_000) {
            // A 2 s stall at 150 s, then a gap: lateness steps up, then back to baseline.
            if (at === 150_000) gaps = 1;
            const late = at < 140_000 ? 240 : at < 150_000 ? 2240 : 240;
            r.onEvent('mrlateness:lat_render', win(215), at);
            r.onEvent(
                'mrvideopace:vp_pace',
                pace({ 'present-lateness-ns': late * MS, 'gaps-collapsed': gaps }),
                at,
            );
            r.summary(at);
        }
        expect(r.summary(300_000).latenessTrend).toEqual({});
        for (let at = 302_000; at <= 330_000; at += 2_000) {
            r.onEvent('mrlateness:lat_render', win(215), at);
            r.onEvent('mrvideopace:vp_pace', pace({ 'gaps-collapsed': 1 }), at);
            r.summary(at);
        }
        expect(r.summary(330_000).latenessTrend).toEqual({ msPerMin: 0 });
    });

    it('a hole in the readings is a gap too, and a reset forgets the trend', () => {
        const r = audio();
        for (let at = 0; at <= 200_000; at += 2_000) {
            r.onEvent('mrlateness:lat_render', win(60), at);
            r.onEvent('mrasrc-stats:outasrc', asrcStats(), at);
            r.summary(at);
        }
        expect(r.summary(200_000).latenessTrend).toEqual({ msPerMin: 0 });
        r.onEvent('mrlateness:lat_render', win(60), 210_000);
        r.onEvent('mrasrc-stats:outasrc', asrcStats(), 210_000);
        expect(r.summary(210_000).latenessTrend).toEqual({});
        r.reset();
        expect(r.summary(212_000).latenessTrend).toBeUndefined();
    });
});

describe('no alarm on lateness (OQ-8, OQ-34)', () => {
    const ROOT = path.resolve(__dirname, '../../../..');
    const manifests = fs
        .readdirSync(path.join(ROOT, 'plugins'))
        .map((id) => path.join(ROOT, 'plugins', id, 'package.json'))
        .filter((f) => fs.existsSync(f))
        .map((f) => JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')).mediaRouter ?? {}));

    it('no manifest has a capacity, lateness or trend alarm setting', () => {
        expect(manifests.length).toBeGreaterThan(20);
        for (const m of manifests) {
            expect(m).not.toMatch(/capacityAlarm|latenessAlarm|trendAlarm|alarmMsPerMin/i);
            expect(m).not.toMatch(/"title":"[^"]*(capacity|lateness)[^"]*alarm/i);
        }
    });

    it('no module warns `capacity`: the trend is a row, never a warning', () => {
        const base = fs.readFileSync(path.join(__dirname, 'GstPluginBase.ts'), 'utf8');
        const kinds = /type OwnedWarning =([^;]*);/.exec(base)![1];
        expect(kinds).toMatch(/'queue-full'/);
        expect(kinds).not.toMatch(/capacity|trend/);
        const r = new LatenessReporter();
        r.onEvent('mrlateness:lat_render', win(200), 0);
        for (let at = 0; at <= 200_000; at += 2_000) {
            r.onEvent(
                'mrvideopace:vp_pace',
                pace({ 'present-lateness-ns': (240 + at / 100) * MS }),
                at,
            );
            r.onEvent('mrlateness:lat_render', win(215), at);
            r.summary(at);
        }
        expect(r.summary(200_000).latenessTrend!.msPerMin).toBeCloseTo(600, 3);
        expect(r.streamWarnings(200_000)).toEqual([]);
    });
});

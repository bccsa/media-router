import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    AsrcWatches,
    asrcWarningText,
    clockCorrectionText,
    ratePpbOf,
    signedPpm,
} from './asrcWatches.js';
import { buildAsrc } from './ingestTiming.js';
import { launchElements } from './launchElements.js';

// `mrasrc-stats` and `mrasrc-event` as gstmrasrc.cpp posts them (WI-P3-5's fields).
const stats = (mode: string, o: Record<string, number | string> = {}) => ({
    state: 'locked',
    'ratio-ppb': 0,
    'phase-err-ns': 0,
    relocks: 0,
    'in-frames': 96_000,
    'out-frames': 96_000,
    'discont-in': 0,
    'dropped-frames': 0,
    mode,
    'source-ppb': 0,
    'device-ppb': 0,
    ...o,
});
const event = (kind: string, o: Record<string, number | string> = {}) => ({
    kind,
    reason: '',
    'house-ns': 1_000_000_000,
    ...o,
});

const DECODE = buildAsrc({ name: 'dasrc', bypassBelowPpm: 0.5 });
const BOTH = buildAsrc({ name: 'outasrc', bypassBelowPpm: 0.5, deviceSink: 'sink' });
const DEVICE = buildAsrc({ name: 'devasrc', deviceSink: 'out sink' });
const CAPTURE = buildAsrc({ outRate: 48000 });
const PIPELINE = [DECODE, BOTH, DEVICE, CAPTURE]
    .map((a) => `audiotestsrc ! ${a} ! fakesink`)
    .join(' ');

function watches(): AsrcWatches {
    const w = new AsrcWatches();
    w.configure(PIPELINE);
    return w;
}
const one = (w: AsrcWatches, name: string) => w.list().find((x) => x.name === name);

describe('launchElements', () => {
    it("reads each named element's properties up to its link, quotes taken off", () => {
        const els = launchElements(`${PIPELINE} ! mrtsdemux name=dm media=audio`, 'mrasrc');
        expect([...els.keys()]).toEqual(['dasrc', 'outasrc', 'devasrc', 'asrc']);
        expect(els.get('outasrc')).toEqual({
            name: 'outasrc',
            'bypass-below-ppm': '0.5',
            'device-sink': 'sink',
        });
        expect(els.get('devasrc')!['device-sink']).toBe('out sink');
        expect(launchElements('xmrasrc name=a ! mrasrcx name=b', 'mrasrc').size).toBe(0);
        expect(launchElements('a ! mrtsdemux name=dm media=audio ! b', 'tsdemux').size).toBe(0);
    });
});

describe('AsrcWatches', () => {
    it("a capture ASRC is its ingest card's: neither its stats nor its events", () => {
        const w = watches();
        expect(w.take('mrasrc-stats', 'asrc', stats('capture'), 0)).toBeNull();
        expect(
            w.take('mrasrc-event', 'asrc', event('relock', { reason: 'discont' }), 0),
        ).toBeNull();
        expect(w.take('mrasrc-stats', 'other', stats('capture'), 0)).toBeNull();
        expect(w.take('level', 'dasrc', {}, 0)).toBeNull();
        expect(w.list()).toEqual([]);
    });

    it('decode: none while bypassed, the source rate (positive fast) once engaged', () => {
        const w = watches();
        w.take('mrasrc-stats', 'dasrc', stats('bypass', { 'source-ppb': 9 }), 0);
        expect(one(w, 'dasrc')).toEqual({ name: 'dasrc', correction: {} });
        w.take('mrasrc-stats', 'dasrc', stats('decode', { 'source-ppb': 23_400 }), 2000);
        expect(one(w, 'dasrc')).toEqual({ name: 'dasrc', correction: { sourcePpm: 23.4 } });
    });

    it('decode + device: `device` while its source passes reads none (house rate) and the device', () => {
        const w = watches();
        w.take('mrasrc-stats', 'outasrc', stats('device', { 'device-ppb': -12_100 }), 0);
        expect(one(w, 'outasrc')).toEqual({ name: 'outasrc', correction: {}, devicePpm: -12.1 });
        w.take(
            'mrasrc-stats',
            'outasrc',
            stats('decode+device', { 'source-ppb': -3_000, 'device-ppb': -12_100 }),
            2000,
        );
        expect(one(w, 'outasrc')).toEqual({
            name: 'outasrc',
            correction: { sourcePpm: -3 },
            devicePpm: -12.1,
        });
    });

    it('the device term alone: a device clock, no correction', () => {
        const w = watches();
        w.take('mrasrc-stats', 'devasrc', stats('device', { 'device-ppb': 40_000 }), 0);
        expect(one(w, 'devasrc')).toEqual({ name: 'devasrc', devicePpm: 40 });
        // A live branch's ASRC (no description entry) is known by its mode.
        w.take('mrasrc-stats', 'mixin_asrc_abc123', stats('device', { 'device-ppb': 5 }), 0);
        expect(one(w, 'mixin_asrc_abc123')!.correction).toBeUndefined();
    });

    it('ratio-out-of-bounds: the warning until the locked source is back below 900 ppm', () => {
        const w = watches();
        w.take('mrasrc-stats', 'dasrc', stats('decode', { 'source-ppb': 1_234_000 }), 0);
        // fit-ppb is the lock's epsilon: a fast source has a negative one.
        const r = w.take(
            'mrasrc-event',
            'dasrc',
            event('ratio-out-of-bounds', { 'fit-ppb': -1_232_480 }),
            1,
        );
        expect(r!.changed).toBe(true);
        expect(r!.event).toMatchObject({ name: 'dasrc', kind: 'ratio-out-of-bounds' });
        expect(one(w, 'dasrc')!.outOfBoundsPpm).toBeCloseTo(1234, 0);
        expect(
            w.take('mrasrc-stats', 'dasrc', stats('decode', { 'source-ppb': 950_000 }), 2)!.changed,
        ).toBe(false);
        const lost = stats('decode', { state: 'acquiring', 'source-ppb': 0, relocks: 1 });
        expect(w.take('mrasrc-stats', 'dasrc', lost, 3)!.changed).toBe(false);
        expect(one(w, 'dasrc')!.outOfBoundsPpm).toBeDefined();
        const back = stats('decode', { 'source-ppb': 899_000, relocks: 1 });
        expect(w.take('mrasrc-stats', 'dasrc', back, 4)!.changed).toBe(true);
        expect(one(w, 'dasrc')!.outOfBoundsPpm).toBeUndefined();
    });

    it('a respawned element (its counters back down) keeps no warning', () => {
        const w = watches();
        w.take(
            'mrasrc-stats',
            'dasrc',
            stats('decode', { 'source-ppb': 1_500_000, relocks: 2 }),
            0,
        );
        w.take('mrasrc-event', 'dasrc', event('ratio-out-of-bounds', { 'fit-ppb': -1_400_000 }), 1);
        const fresh = stats('bypass', {
            'in-frames': 4800,
            'source-ppb': 1_500_000,
            state: 'acquiring',
        });
        expect(w.take('mrasrc-stats', 'dasrc', fresh, 2)!.changed).toBe(true);
        expect(one(w, 'dasrc')!.outOfBoundsPpm).toBeUndefined();
    });

    it("an engage carries the source's rate for the log; other events pass as they are", () => {
        const w = watches();
        const engaged = event('engaged', {
            reason: 'ratio',
            'source-ppb': 3_000,
            'phase-ns': 120_000,
        });
        expect(w.take('mrasrc-event', 'dasrc', engaged, 0)).toEqual({
            changed: false,
            event: {
                name: 'dasrc',
                kind: 'engaged',
                reason: 'ratio',
                payload: engaged,
                sourcePpm: 3,
            },
        });
        const relock = event('device-relock', { reason: 'sync-latency' });
        expect(w.take('mrasrc-event', 'outasrc', relock, 0)!.event).toEqual({
            name: 'outasrc',
            kind: 'device-relock',
            reason: 'sync-latency',
            payload: relock,
        });
    });

    it('expires an ASRC that stopped reporting; a configure forgets the old run', () => {
        const w = watches();
        w.take('mrasrc-stats', 'dasrc', stats('bypass'), 0);
        w.expire(6001, 6000);
        expect(w.list()).toEqual([]);
        w.configure('audiotestsrc ! fakesink');
        expect(w.take('mrasrc-event', 'outasrc', event('device-relock'), 0)).toBeNull();
    });
});

describe('the texts', () => {
    it('signed ppm with a true minus, one decimal', () => {
        expect(signedPpm(23.4)).toBe('+23.4 ppm');
        expect(signedPpm(-12.14)).toBe('−12.1 ppm');
        expect(signedPpm(0.04)).toBe('0.0 ppm');
        expect(clockCorrectionText({})).toBe('none (house rate)');
        expect(clockCorrectionText({ sourcePpm: 23.4 })).toBe('+23.4 ppm (source)');
        expect(clockCorrectionText({ sourcePpm: -0.3 })).toBe('−0.3 ppm (source)');
    });

    it("the rate of a lock's epsilon is the stats' own (asrc_rate_of)", () => {
        expect(ratePpbOf(0)).toBe(0);
        expect(ratePpbOf(-40_000)).toBe(40_002);
        expect(ratePpbOf(1_000_000)).toBe(-999_001);
    });

    it('the out-of-bounds warning names the input, or the module for its own ASRC', () => {
        expect(asrcWarningText(1234.5, 'enc-1 (out)')).toBe(
            "Input enc-1 (out): source clock +1234.5 ppm off house time, past the ASRC's 1000 ppm" +
                " — check the source's sample rate",
        );
        expect(asrcWarningText(-1500)).toMatch(/^Source clock −1500\.0 ppm off house time/);
    });
});

describe('the forwarded messages as recorded (forwarded-messages.json)', () => {
    const fixture = JSON.parse(
        readFileSync(
            join(process.cwd(), 'plugins/mpegts-core/tests/fixtures/forwarded-messages.json'),
            'utf8',
        ),
    ) as { 'mrasrc-stats': Record<string, unknown>; 'mrasrc-event': Record<string, object> };

    it("make the engine's rows, warning and log events", () => {
        const w = new AsrcWatches();
        w.configure(`audiotestsrc ! ${BOTH} ! fakesink`);
        const stats = fixture['mrasrc-stats'];
        w.take('mrasrc-stats', 'outasrc', stats, 0);
        expect(one(w, 'outasrc')).toEqual({ name: 'outasrc', correction: {}, devicePpm: 0 });
        const events = fixture['mrasrc-event'];
        for (const kind of ['device-relock', 'engaged', 'relock']) {
            expect(w.take('mrasrc-event', 'outasrc', events[kind], 1)!.event!.kind).toBe(kind);
        }
        expect(w.take('mrasrc-event', 'outasrc', events.engaged, 1)!.event!.sourcePpm).toBe(3);
        expect(w.take('mrasrc-event', 'outasrc', events['ratio-out-of-bounds'], 1)!.changed).toBe(
            true,
        );
        expect(one(w, 'outasrc')!.outOfBoundsPpm).toBeCloseTo(1300, 1);
        w.take('mrasrc-stats', 'outasrc', { ...stats, mode: 'decode+device', state: 'locked' }, 2);
        expect(one(w, 'outasrc')!.outOfBoundsPpm).toBeUndefined();
    });
});

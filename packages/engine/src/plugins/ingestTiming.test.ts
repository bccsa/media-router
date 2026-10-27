import { describe, it, expect } from 'vitest';
import {
    INGEST_OFFSET_KEY,
    PID_TRIMS_KEY,
    SMOOTHING_COOLDOWN_KEY,
    applyIngestTimingLiveUpdate,
    asrcBusReports,
    buildAsrc,
    buildRestamp,
    restampBusReports,
} from './ingestTiming.js';
import { CH, MS, event, pidMsg, setup, stats } from './testing/ingestTimingFixtures.js';

const MIN = 60_000 * MS;
// The default cooldown, 5 min: B-95's 300 s.
const STC = `mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=${5 * MIN}`;

describe('buildRestamp', () => {
    it('a network ingest: STC mode, O and the trims in ns, in PID order', () => {
        expect(
            buildRestamp({ mode: 'stc', offsetMs: 250, pidTrimsMs: { 257: -40, 256: 120 } }),
        ).toBe(`${STC} offset-ns=250000000 pid-trims="256=120000000;257=-40000000"`);
    });

    it('defaults: O = 0 and no trims', () => {
        expect(buildRestamp({ mode: 'stc' })).toBe(`${STC} offset-ns=0`);
        expect(buildRestamp({ mode: 'stc', pidTrimsMs: {} })).toBe(`${STC} offset-ns=0`);
    });

    it('a capture: fixed mode, and the base time for the video-encoder; no clock lock, no cooldown', () => {
        expect(buildRestamp({ mode: 'fixed', offsetMs: -20 })).toBe(
            'mrtsrestamp name=restamp clock-mode=fixed offset-ns=-20000000',
        );
        expect(buildRestamp({ mode: 'fixed', smoothingCooldownMin: 2 })).toBe(
            'mrtsrestamp name=restamp clock-mode=fixed offset-ns=0',
        );
        expect(buildRestamp({ mode: 'fixed', addBaseTime: true, name: 'rs' })).toBe(
            'mrtsrestamp name=rs clock-mode=fixed add-base-time=true offset-ns=0',
        );
    });

    it('clamps O to ±10 s and each trim to ±2 s', () => {
        expect(
            buildRestamp({ mode: 'stc', offsetMs: 25_000, pidTrimsMs: { 256: 5000, 257: -9000 } }),
        ).toBe(`${STC} offset-ns=10000000000 pid-trims="256=2000000000;257=-2000000000"`);
        expect(buildRestamp({ mode: 'stc', offsetMs: -10_001 })).toBe(
            `${STC} offset-ns=-10000000000`,
        );
    });

    it('the smoothing cooldown in ns, clamped to 0-60 min; 0 is off', () => {
        const cooldown = (smoothingCooldownMin: unknown) =>
            buildRestamp({ mode: 'stc', smoothingCooldownMin }).replace(
                /.* smoothing-cooldown-ns=(\d+) .*/,
                '$1',
            );
        expect(cooldown(2)).toBe(String(2 * MIN));
        expect(cooldown(2.5)).toBe(String(150_000 * MS));
        expect(cooldown(0)).toBe('0');
        expect(cooldown(60)).toBe(String(60 * MIN));
        expect(cooldown(90)).toBe(String(60 * MIN));
        expect(cooldown(-5)).toBe('0');
        expect(buildRestamp({ mode: 'stc', smoothingCooldownMin: 10, offsetMs: 5 })).toBe(
            `mrtsrestamp name=restamp clock-mode=stc smoothing-cooldown-ns=${10 * MIN} offset-ns=5000000`,
        );
    });

    it('anything but a finite number is the default 5 min', () => {
        for (const smoothingCooldownMin of [undefined, null, '2', NaN, Infinity, -Infinity, {}]) {
            expect(buildRestamp({ mode: 'stc', smoothingCooldownMin })).toBe(`${STC} offset-ns=0`);
        }
    });

    it('drops what is not a setting: junk O is 0; bad keys, values and zero trims go', () => {
        for (const offsetMs of [undefined, null, '250', NaN, Infinity, {}]) {
            expect(buildRestamp({ mode: 'stc', offsetMs })).toBe(`${STC} offset-ns=0`);
        }
        const trims = {
            ...{ '0x100': 5, '0256': 5, abc: 5, '8192': 5, '-1': 5 },
            ...{ 256: '5', 257: 0, 8191: 1.5 },
        };
        expect(buildRestamp({ mode: 'stc', pidTrimsMs: trims })).toBe(
            `${STC} offset-ns=0 pid-trims="8191=1500000"`,
        );
        expect(buildRestamp({ mode: 'stc', pidTrimsMs: [1, 2] })).toBe(`${STC} offset-ns=0`);
    });
});

describe('buildAsrc and the bus reports', () => {
    it('builds the ASRC with an optional fixed output rate', () => {
        expect(buildAsrc()).toBe('mrasrc name=asrc');
        expect(buildAsrc({ outRate: 48000 })).toBe('mrasrc name=asrc out-rate=48000');
        expect(buildAsrc({ name: 'asrc2', outRate: 0 })).toBe('mrasrc name=asrc2');
    });

    it('builds the decode and device modes (WI-P3-5) in the consumer strings', () => {
        expect(buildAsrc({ bypassBelowPpm: 0.5, outRate: 48000 })).toBe(
            'mrasrc name=asrc bypass-below-ppm=0.5 out-rate=48000',
        );
        expect(buildAsrc({ bypassBelowPpm: 0.5, deviceSink: 'sink' })).toBe(
            'mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink',
        );
        expect(buildAsrc({ name: 'outasrc', deviceSink: 'sink' })).toBe(
            'mrasrc name=outasrc device-sink=sink',
        );
    });

    it('leaves out a bypass that is no number above 0, holds it to 1000 ppm, quotes an odd sink name', () => {
        for (const bypassBelowPpm of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(buildAsrc({ bypassBelowPpm })).toBe('mrasrc name=asrc');
        }
        expect(buildAsrc({ bypassBelowPpm: 5000 })).toBe('mrasrc name=asrc bypass-below-ppm=1000');
        expect(buildAsrc({ deviceSink: '' })).toBe('mrasrc name=asrc');
        expect(buildAsrc({ deviceSink: 'out sink' })).toBe(
            'mrasrc name=asrc device-sink="out sink"',
        );
    });

    it('subscribes to the three restamp messages and the two ASRC messages', () => {
        expect(restampBusReports()).toEqual([
            { element: 'restamp', structure: 'mrtsrestamp-stats' },
            { element: 'restamp', structure: 'mrtsrestamp-pid' },
            { element: 'restamp', structure: 'mrtsrestamp-event' },
        ]);
        expect(asrcBusReports('a1')).toEqual([
            { element: 'a1', structure: 'mrasrc-stats' },
            { element: 'a1', structure: 'mrasrc-event' },
        ]);
    });
});

describe('applyIngestTimingLiveUpdate', () => {
    const control = () => {
        const calls: unknown[][] = [];
        return { calls, setElementProperty: async (...a: unknown[]) => void calls.push(a) };
    };

    it('O goes to offset-ns on the restamp, clamped to ±10 s', async () => {
        const m = control();
        await applyIngestTimingLiveUpdate(m, { [INGEST_OFFSET_KEY]: 500 });
        await applyIngestTimingLiveUpdate(m, { [INGEST_OFFSET_KEY]: -25_000 });
        expect(m.calls).toEqual([
            ['restamp', 'offset-ns', 500 * MS],
            ['restamp', 'offset-ns', -10_000 * MS],
        ]);
    });

    it('the trim map goes whole to pid-trims, clamped; an emptied map clears them', async () => {
        const m = control();
        await applyIngestTimingLiveUpdate(m, { [PID_TRIMS_KEY]: { 256: 3000, 257: -12 } });
        await applyIngestTimingLiveUpdate(m, { [PID_TRIMS_KEY]: {} }, 'rs');
        expect(m.calls).toEqual([
            ['restamp', 'pid-trims', '256=2000000000;257=-12000000'],
            ['rs', 'pid-trims', ''],
        ]);
    });

    it('the cooldown goes to smoothing-cooldown-ns in ns, clamped to 0-60 min, junk the default', async () => {
        const m = control();
        for (const v of [10, 0, 120, 'x']) {
            await applyIngestTimingLiveUpdate(m, { [SMOOTHING_COOLDOWN_KEY]: v });
        }
        expect(m.calls).toEqual([
            ['restamp', 'smoothing-cooldown-ns', 10 * MIN],
            ['restamp', 'smoothing-cooldown-ns', 0],
            ['restamp', 'smoothing-cooldown-ns', 60 * MIN],
            ['restamp', 'smoothing-cooldown-ns', 5 * MIN],
        ]);
    });

    it('other keys set nothing', async () => {
        const m = control();
        await applyIngestTimingLiveUpdate(m, { playoutOffsetMs: 80, volume: 50 });
        expect(m.calls).toEqual([]);
    });
});

describe('IngestTimingReporter: a recorded locked → degraded → recovered sequence', () => {
    it('maps to the Clock and PID sections, the badge and the warning, throttled', () => {
        const { rep, card } = setup();
        const audio = pidMsg(257, 0x0f, [280, 300, 330], {
            'trim-ns': -40 * MS,
            'shift-ns': -40 * MS,
        });
        const report = (t: number, s: Record<string, unknown>, lead: number[]) => {
            rep.onEvent(CH.stats, stats(s), t);
            rep.onEvent(CH.pid, pidMsg(256, 0x1b, lead), t);
            rep.onEvent(CH.pid, audio, t);
            rep.tick(t);
        };

        report(2000, { state: 'acquiring', ppb: 0 }, [300, 340, 420]);
        expect(card.sections.map((s) => [s.id, s.label])).toEqual([
            ['clock', 'Clock'],
            ['pid-256', 'PID 0x0100 · H.264 video'],
            ['pid-257', 'PID 0x0101 · AAC audio'],
        ]);
        expect(card.sections[0].fields).toEqual([
            { key: 'state', label: 'State' },
            { key: 'sourceRate', label: 'Source rate', unit: 'ppm' },
            { key: 'residualP99', label: 'Residual p99', unit: 'ms' },
            { key: 'relocks', label: 'Re-locks' },
            { key: 'lastEvent', label: 'Last event' },
        ]);
        expect(card.sections[1].fields).toEqual([
            { key: 'lead', label: 'Lead min / median / max', unit: 'ms' },
            { key: 'trim', label: 'Trim', unit: 'ms' },
            { key: 'shift', label: 'Shift O + trim', unit: 'ms' },
            { key: 'dropped', label: 'Dropped (last 10 min)', unit: 'PES' },
        ]);
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'Acquiring', color: '#6b7280' });
        expect(card.options.pids).toEqual([
            { value: '256', label: '0x0100 H.264 video' },
            { value: '257', label: '0x0101 AAC audio' },
        ]);
        expect(card.data['pid-257']).toEqual({
            lead: '280 / 300 / 330',
            trim: -40,
            shift: -40,
            dropped: 0,
        });

        report(4000, {}, [300, 340, 420]);
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'Locked', color: '#10b981' });
        expect(card.data.clock).toEqual({
            state: 'Locked',
            sourceRate: 1.23,
            residualP99: 4,
            relocks: 0,
            lastEvent: '—',
        });

        // Moves under 1 ms and 0.01 ppm from what is shown publish nothing ...
        const emits = card.emits;
        report(6000, { ppb: 1238, 'residual-p99-ns': 4.9 * MS }, [300.4, 340.9, 419.2]);
        expect(card.emits).toBe(emits);
        // ... a median 1 ms off it does.
        report(8000, { ppb: 1238, 'residual-p99-ns': 4.9 * MS }, [300.4, 341, 419.2]);
        expect(card.emits).toBeGreaterThan(emits);
        expect(card.data['pid-256'].lead).toBe('300 / 341 / 419');
        expect(card.data.clock.residualP99).toBe(5);

        const degraded = event('degraded', { reason: 'freeze', pid: 256 });
        rep.onEvent(CH.event, degraded, 9000);
        report(10_000, { state: 'degraded', reason: 'freeze' }, [0, 0, 1]);
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'Degraded', color: '#f59e0b' });
        expect(card.data.clock.state).toBe('Degraded (PCR frozen)');
        expect(card.data.clock.lastEvent).toBe('degraded (PCR frozen), just now');
        expect(card.warning).toBe(
            'Degraded clock: PCR frozen — timing from PID 0x0100 PTS against arrival',
        );
        // A steady degraded stream, the event's age included, publishes nothing more.
        const degradedEmits = card.emits;
        for (let t = 12_000; t <= 40_000; t += 2000) {
            report(t, { state: 'degraded', reason: 'freeze' }, [0, 0, 1]);
        }
        expect(card.emits).toBe(degradedEmits);
        expect(card.warns).toBe(1);

        rep.onEvent(CH.event, event('recovered', { reason: 'freeze' }), 41_000);
        report(42_000, {}, [300, 340, 420]);
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'Locked', color: '#10b981' });
        expect(card.data.clock.lastEvent).toBe('recovered (PCR frozen), just now');
        expect(card.warning).toBeNull();
        expect([card.warns, card.clears]).toEqual([1, 1]);
        expect(card.logs).toEqual([
            ['warn', { 'mrtsrestamp-event': degraded }, 'mrtsrestamp-event degraded (freeze)'],
            [
                'info',
                { 'mrtsrestamp-event': event('recovered', { reason: 'freeze' }) },
                'mrtsrestamp-event recovered (freeze)',
            ],
        ]);
    });
});

import { describe, it, expect } from 'vitest';
import type { DrainSummary, ModuleTimingSummary } from '@media-router/shared-types';
import type { DrainFields } from './asrcWatches.js';
import {
    drainDoneText,
    drainSeconds,
    drainStartText,
    drainSummary,
    latencyTargetText,
    underrunsText,
} from './drainSummary.js';
import { latenessTrendText } from './latenessTrend.js';
import { LatenessReporter } from './latenessReporter.js';
import { timingChanged, timingPublication } from './timingSections.js';
import { VideoPaceWatches, rateMatchText } from './videoPaceWatches.js';

// The drain's rows, trend labels and summary (WI-P4-18, B-179; design part 9).
const fields = (o: Partial<DrainFields> = {}): DrainFields => ({
    ppm: 5000,
    excessMs: 2315,
    marginMs: 60,
    troughMs: 2375,
    drainedMs: 0,
    raises: 0,
    underruns: 0,
    outages: 0,
    state: 'draining',
    capped: false,
    publishedMs: 95,
    ...o,
});
const summary = (o: Partial<DrainSummary> = {}): DrainSummary => ({
    ...drainSummary(fields(), 2410, undefined),
    ...o,
});

describe('the Latency target row', () => {
    it('reads its target, now, and the drain with its time (part 5)', () => {
        expect(latencyTargetText(summary())).toBe(
            '95 ms (measured), now 2.41 s · draining at 0.50 % (about 8 min)',
        );
        expect(Math.round(drainSeconds(2315))).toBe(493);
        expect(Math.round(drainSeconds(500))).toBe(130);
        expect(drainSeconds(15)).toBe(0);
    });

    it('a grouped member: in sync with its group; rising to it; held at its cap; two programmes', () => {
        const g = drainSummary(
            fields({ ppm: -2000, state: 'rising', groupTargetMs: 300, excessMs: 0 }),
            200,
            {
                with: ['Video Player', 'Audio Output 302M'],
                withRenderMs: [210, 230],
            },
        );
        expect(g.targetMs).toBe(300);
        expect(latencyTargetText(g)).toBe(
            '300 ms (measured), now 200 ms · rising to its group at 0.20 % · in sync with Video Player, Audio Output 302M',
        );
        const capped = drainSummary(
            fields({ ppm: 0, state: 'idle', capped: true, groupTargetMs: 3000, excessMs: 0 }),
            1200,
            {
                with: ['Video Player'],
                withRenderMs: [1230],
            },
        );
        expect(capped.targetMs).toBe(2200);
        expect(latencyTargetText(capped)).toBe(
            '2.20 s (measured), now 1.20 s · held 1 s above its own target · in sync with Video Player',
        );
        const two = drainSummary(fields({ ppm: 0, state: 'idle', excessMs: 5 }), 100, {
            neither: ['A', 'B'],
        });
        expect(latencyTargetText(two)).toBe(
            '95 ms (measured), now 100 ms · in sync with neither (two programmes)',
        );
    });

    it('in sync only within 45 ms of every member; otherwise how far, and why (B-241)', () => {
        const at = (nowMs: number, theirs: Array<number | null>, o: Partial<DrainFields> = {}) =>
            drainSummary(
                fields({ ppm: 0, state: 'idle', groupTargetMs: 300, excessMs: 0, ...o }),
                nowMs,
                {
                    with: ['Video Player', 'Audio Output 302M'].slice(0, theirs.length),
                    withRenderMs: theirs,
                },
            );
        // 30 ms off: in sync.
        expect(latencyTargetText(at(300, [330]))).toBe(
            '300 ms (measured), now 300 ms · in sync with Video Player',
        );
        expect(at(300, [345]).groupApart).toBeUndefined();
        expect(at(300, [346]).groupApart).toEqual({ name: 'Video Player', ms: -46 });
        // The python vpq60 run: the video 4.5 s behind its audio, under "in sync with".
        const video = at(4800, [300], {});
        expect(latencyTargetText(video)).toBe(
            '300 ms (measured), now 4.80 s · 4.50 s behind Video Player',
        );
        // The audio, held at its cap: the furthest member named, and why it stays apart.
        const audio = at(1300, [5800, 1310], { capped: true, groupTargetMs: 5800 });
        expect(audio.groupApart).toEqual({ name: 'Video Player', ms: -4500 });
        expect(latencyTargetText(audio)).toBe(
            '2.30 s (measured), now 1.30 s · 4.50 s ahead of Video Player (held 1 s above its own target)',
        );
        // Rising to it, while further than 45 ms.
        const rising = at(200, [600], { ppm: -2000, state: 'rising', groupTargetMs: 600 });
        expect(latencyTargetText(rising)).toBe(
            "600 ms (measured), now 200 ms · rising to Video Player's latency at 0.20 %",
        );
        // Rising to a later member while an earlier one, itself rising, is the furthest.
        const between = at(500, [1000, -200], { ppm: -2000, state: 'rising', groupTargetMs: 1000 });
        expect(between.groupApart).toEqual({ name: 'Audio Output 302M', ms: 700 });
        expect(latencyTargetText(between)).toBe(
            '1.00 s (measured), now 500 ms · rising to its group at 0.20 % · 700 ms behind Audio Output 302M',
        );
        // A member whose lateness is unknown: grouped, its sync not claimed.
        expect(latencyTargetText(at(300, [310, null]))).toBe(
            '300 ms (measured), now 300 ms · grouped with Video Player, Audio Output 302M',
        );
        expect(latencyTargetText(at(300, [900, null]))).toBe(
            '300 ms (measured), now 300 ms · 600 ms ahead of Video Player',
        );
    });

    it('an early group (targets below 0) is followed and named; one alone is not in sync (B-177)', () => {
        const early = drainSummary(
            fields({
                ppm: -2000,
                state: 'rising',
                groupTargetMs: -110,
                excessMs: 0,
                publishedMs: -520,
            }),
            -520,
            { with: ['Audio Decoder'], withRenderMs: [-500] },
        );
        expect(early.targetMs).toBe(-110);
        expect(latencyTargetText(early)).toBe(
            '-110 ms (measured), now -520 ms · rising to its group at 0.20 % · in sync with Audio Decoder',
        );
        const alone = drainSummary(fields({ ppm: 0, state: 'idle', excessMs: 0 }), -520, {
            with: ['Audio Decoder'],
        });
        expect(alone.targetMs).toBe(-520);
        expect(latencyTargetText(alone)).toBe('-520 ms (measured), now -520 ms');
    });

    it('(h) Trust links 1.4 s apart (p5-20): in sync within 1 s only, the spread named beside the cap', () => {
        // The lower member held 1 s above its own target, 400 ms short of the group.
        const low = drainSummary(
            fields({
                ppm: 0,
                state: 'idle',
                capped: true,
                groupTargetMs: 1500,
                excessMs: 1000,
                publishedMs: 100,
            }),
            1100,
            { with: ['Video Player'], withRenderMs: [1500], spreadMs: 1400 },
        );
        expect(low.groupSpreadMs).toBe(1400);
        expect(latencyTargetText(low)).toBe(
            '1.10 s (measured), now 1.10 s · 400 ms ahead of Video Player (held 1 s above its own target) · in sync with Video Player within 1 s only: the links differ by 1.4 s',
        );
        const high = drainSummary(
            fields({ ppm: 0, state: 'idle', groupTargetMs: 1500, excessMs: 0, publishedMs: 1500 }),
            1500,
            { with: ['Audio Output 302M'], withRenderMs: [1100], spreadMs: 1400 },
        );
        expect(latencyTargetText(high)).toBe(
            '1.50 s (measured), now 1.50 s · 400 ms behind Audio Output 302M · in sync with Audio Output 302M within 1 s only: the links differ by 1.4 s',
        );
        // Alone (no group target from the element yet): no group, no spread.
        const alone = drainSummary(fields({ ppm: 0, state: 'idle', excessMs: 0 }), 100, {
            with: ['Video Player'],
            spreadMs: 1400,
        });
        expect(alone.groupSpreadMs).toBeUndefined();
    });

    it('a negative excess (a clean link under its margin): the target is now, never above it (fix 2)', () => {
        const live = drainSummary(
            fields({ ppm: 0, state: 'idle', excessMs: -20, publishedMs: 2 }),
            2,
            undefined,
        );
        expect(live.targetMs).toBe(2);
        expect(latencyTargetText(live)).toBe('2 ms (measured), now 2 ms');
    });

    it('no display rate: not measured (M4); warming up: measuring', () => {
        const v = drainSummary(fields({ ppm: 0, state: 'warm-up', excessMs: 0 }), 240, undefined, {
            rateKnown: false,
        });
        expect(latencyTargetText(v)).toBe('not measured (no display rate)');
        const w = drainSummary(fields({ ppm: 0, state: 'warm-up', excessMs: 0 }), 240, undefined);
        expect(latencyTargetText(w)).toBe('240 ms (measured), now 240 ms · measuring');
    });

    it('Drained and Buffer underruns; the log lines', () => {
        expect(underrunsText(summary({ underruns: 3, raises: 3 }))).toBe('3, 3 raised the target');
        expect(underrunsText(summary())).toBe('0');
        // B-240: why the others did not raise, in the row's words.
        expect(
            underrunsText(
                summary({
                    underruns: 15,
                    raises: 1,
                    underrunReasons: { drain: 9, 'after-drain': 3, load: 2 },
                }),
            ),
        ).toBe('15, 1 raised the target, 12 while catching up, 2 under load');
        expect(
            underrunsText(
                summary({
                    underruns: 6,
                    raises: 0,
                    underrunReasons: { 'warm-up': 1, input: 1, 'not-margin': 1, video: 3 },
                }),
            ),
        ).toBe(
            '6, 0 raised the target, 1 while settling, 1 after an input break, 1 not short of margin, 3 on a steady stream',
        );
        // B-256: a Video Player's late frames never raise; the row says why each one came.
        expect(
            underrunsText(
                summary({
                    underruns: 12,
                    raises: 0,
                    underrunReasons: { drain: 5, 'after-drain': 4, video: 3 },
                }),
            ),
        ).toBe('12, 0 raised the target, 9 while catching up, 3 on a steady stream');
        // The element's fields carry through the summary.
        const r = drainSummary(fields({ underruns: 2, reasons: { load: 2 } }), 2410, undefined);
        expect(r.underrunReasons).toEqual({ load: 2 });
        expect(underrunsText(r)).toBe('2, 0 raised the target, 2 under load');
        expect(drainStartText(summary())).toBe(
            'Draining 2.31 s of built-up latency at up to 0.5 % (about 8 min)',
        );
        expect(drainDoneText(summary({ drainedMs: 2300, targetMs: 95 }))).toBe(
            'Back at its latency target (95 ms): drained 2.30 s',
        );
    });
});

describe('the Lateness trend by the servo', () => {
    it('draining: draining to its target; at its cap and growing: faster than it can drain', () => {
        expect(latenessTrendText({ msPerMin: -300 }, { state: 'draining', ppm: 5000 })).toBe(
            '−300 ms/min — draining to its target',
        );
        expect(latenessTrendText({ msPerMin: 40 }, { state: 'draining', ppm: 5000 })).toBe(
            '+40 ms/min — growing faster than it can drain (0.5 %)',
        );
        // Otherwise today's: a slower device or decode, nothing ready early to drain.
        expect(latenessTrendText({ msPerMin: 40 }, { state: 'idle', ppm: 0 })).toBe(
            '+40 ms/min — decode or device slower than real time',
        );
        expect(latenessTrendText({ msPerMin: -3 }, { state: 'idle', ppm: 0 })).toBe('−3 ms/min');
    });
});

describe('the timing section', () => {
    const base: ModuleTimingSummary = { instrument: true, inputs: [], renderMs: 2410 };

    it('Latency target, Drained and Buffer underruns rows; the rate match with drain drops', () => {
        const s: ModuleTimingSummary = {
            ...base,
            drain: summary({ drainedMs: 340, drainDropsPerMin: 15 }),
            latenessTrend: { msPerMin: -300 },
            rateMatch: { contentFps: 50, displayHz: 50, displaySource: 'achieved', dropsPerMin: 0 },
        };
        expect(timingPublication(s).data.timing).toMatchObject({
            latencyTarget: '95 ms (measured), now 2.41 s · draining at 0.50 % (about 8 min)',
            drained: '340 ms',
            underruns: '0',
            latenessTrend: '−300 ms/min — draining to its target',
            rateMatch: '50.00 fps → 50.00 Hz achieved, 0 drops/min, 15 drain drops/min',
        });
        expect(rateMatchText(s.rateMatch!)).toBe('50.00 fps → 50.00 Hz achieved, 0 drops/min');
    });

    it('timingChanged: the rows as shown move it, a sub-step does not', () => {
        const a: ModuleTimingSummary = { ...base, drain: summary() };
        expect(timingChanged(a, { ...base, drain: summary({ drainedMs: 0.2 }) })).toBe(false);
        expect(timingChanged(a, { ...base, drain: summary({ drainedMs: 20 }) })).toBe(true);
        expect(timingChanged(a, { ...base, drain: summary({ state: 'idle', ppm: 0 }) })).toBe(true);
    });
});

describe('the reporter', () => {
    const paceMsg = (o: Record<string, unknown> = {}) => ({
        released: 500,
        late: 0,
        'rate-drops': 0,
        'gaps-collapsed': 0,
        'content-fps-x100': 5000,
        'refresh-ns': 20_000_000,
        'refresh-source': 'measured',
        'achieved-ns': 0,
        'display-behind': 0,
        'mean-hold-ns': 0,
        'present-lateness-ns': 240_000_000,
        'display-presenting': true,
        'drain-ppm': 0,
        'drain-excess-ns': 10_000_000,
        'drain-margin-ns': 40_000_000,
        'drain-learned-ns': -1,
        'fill-trough-ns': 50_000_000,
        'drained-ns': 0,
        'drain-raises': 0,
        underruns: 0,
        'drain-outages': 0,
        'drain-target-lateness-ns': 230_000_000,
        'group-target-ns': 300_000_000,
        'drain-state': 'rising',
        'drain-capped': false,
        'drain-member': true,
        'drain-rate-known': true,
        'drain-drops': 0,
        ...o,
    });

    it("a Video Player's summary carries its pace's drain, its group and its drain drops", () => {
        const r = new LatenessReporter();
        r.configure('mrvideopace name=vp_pace backlog-queue=vp_esq ! fakesink');
        r.setDrainGroup({ with: ['Audio Decoder'] });
        r.onEvent('mrvideopace:vp_pace', paceMsg(), 0);
        r.onEvent('mrvideopace:vp_pace', paceMsg({ 'drain-drops': 3 }), 60_000);
        const d = r.summary(60_000).drain!;
        expect(d).toMatchObject({
            targetMs: 300,
            nowMs: 240,
            state: 'rising',
            publishedMs: 230,
            groupWith: ['Audio Decoder'],
            drainDropsPerMin: 3,
        });
        r.onEvent(
            'mrvideopace:vp_pace',
            paceMsg({ 'drain-rate-known': false, 'drain-member': false }),
            62_000,
        );
        const n = r.summary(62_000).drain!;
        expect(n.notMeasured).toBe(true);
        expect(n.publishedMs).toBeUndefined();
    });

    it('the pace watch keeps its drain drops per minute', () => {
        const w = new VideoPaceWatches();
        w.take('vp_pace', paceMsg(), 0);
        w.take('vp_pace', paceMsg({ 'drain-drops': 12 }), 30_000);
        expect(w.list()[0].drainDropsPerMin).toBe(24);
        expect(w.list()[0].rateKnown).toBe(true);
    });
});

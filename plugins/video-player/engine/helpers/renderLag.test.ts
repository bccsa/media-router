import { describe, it, expect } from 'vitest';
import {
    describeRenderLag,
    POST_RESUME_HEAL_WINDOW_MS,
    RENDER_LAG_REEMIT_MS,
    RENDER_LAG_SILENT_TICK_MS,
    shouldSelfHealAfterResume,
    shouldWarnRenderLag,
    shouldWarnSilentChain,
} from './renderLag.js';

describe('describeRenderLag', () => {
    it('blames the render chain when the sink presents fewer frames than arrive', () => {
        expect(describeRenderLag({ achievedFps: 41, expectedFps: 50, arrivalsFps: 50 })).toEqual({
            kind: 'render-chain',
            sourceShortfall: false,
            message:
                "Video output can't keep up (41/50 fps) — lower the stream or display resolution",
        });
    });

    it('blames the source when presented ≈ arrivals (within the 1 fps slack)', () => {
        // Field case 2026-08-01: the link dips, the display is fine. Telling
        // the operator to lower the resolution would be wrong advice.
        expect(describeRenderLag({ achievedFps: 41, expectedFps: 50, arrivalsFps: 41.5 })).toEqual({
            kind: 'source-shortfall',
            sourceShortfall: true,
            message:
                'Stream under-delivering (41/50 fps) — check the source/link (display is keeping up)',
        });
    });

    it('omits the rate clause when the runner did not report both fps values', () => {
        expect(describeRenderLag({ achievedFps: 41 }).message).toBe(
            "Video output can't keep up — lower the stream or display resolution",
        );
    });

    it('treats a missing arrivalsFps (older runner) as a render-chain shortfall', () => {
        const report = describeRenderLag({ achievedFps: 41, expectedFps: 50 });
        expect(report.sourceShortfall).toBe(false);
    });

    it('survives a null / non-object payload', () => {
        expect(describeRenderLag(null).sourceShortfall).toBe(false);
        expect(describeRenderLag(undefined).message).toContain("can't keep up");
    });

    describe('total stall (0 presented, 0 arriving at the sink)', () => {
        // Field case: renderwatch reported 0/50 fps for minutes with the source
        // demonstrably healthy. `achieved >= arrivals - 1` is trivially true at
        // 0/0, so the operator was sent to check a link that was fine.
        const stall = { achievedFps: 0, expectedFps: 50, arrivalsFps: 0 };

        it('blames the pipeline, not the source, when the bus is still flowing', () => {
            expect(describeRenderLag(stall, { sourceSilent: false })).toEqual({
                kind: 'total-stall',
                sourceShortfall: false,
                message:
                    'Video output stalled (0/50 fps) — the source is still delivering, the decode/display chain has stopped',
            });
        });

        it('states the ambiguity when the module has no upstream signal', () => {
            const report = describeRenderLag(stall);
            expect(report.kind).toBe('total-stall');
            expect(report.sourceShortfall).toBe(false);
            expect(report.message).toBe(
                'Video output stalled (0/50 fps) — nothing is being rendered; check the display/pipeline (upstream delivery unconfirmed)',
            );
            // Never the old wrong advice: the display is presenting NOTHING.
            expect(report.message).not.toContain('display is keeping up');
        });

        it('keeps source attribution when the bus-stall watchdog confirms silence', () => {
            expect(describeRenderLag(stall, { sourceSilent: true })).toEqual({
                kind: 'source-shortfall',
                sourceShortfall: true,
                message: 'No video arriving (0/50 fps) — the source has stopped delivering',
            });
        });

        it('treats an older runner (no arrivalsFps) with 0 presented as a stall too', () => {
            const report = describeRenderLag(
                { achievedFps: 0, expectedFps: 50 },
                { sourceSilent: false },
            );
            expect(report.kind).toBe('total-stall');
            expect(report.sourceShortfall).toBe(false);
        });

        it('still blames the render chain when a trickle arrives but none is presented', () => {
            // Frames DO reach the sink and none is shown — that is the display,
            // whatever the 1 fps slack would have said about 0 vs 0.4.
            const report = describeRenderLag({ achievedFps: 0, expectedFps: 50, arrivalsFps: 0.4 });
            expect(report.kind).toBe('render-chain');
            expect(report.sourceShortfall).toBe(false);
        });

        it('a total stall is self-healable — a rebuild can fix a wedged decoder', () => {
            const now = 1_000_000;
            expect(
                shouldSelfHealAfterResume({
                    sourceShortfall: describeRenderLag(stall, { sourceSilent: false })
                        .sourceShortfall,
                    healDone: false,
                    lastStallResumeAt: now - 10_000,
                    now,
                }),
            ).toBe(true);
        });
    });

    describe('presentation backlog (the time-sync contract ratchet)', () => {
        // THE FIELD PAYLOAD, verbatim from .42 on 2026-08-14 07:19 — hours of
        // it, every two seconds. The source was delivering a clean 50 fps and
        // the decoder was decoding all of it (codec IRQ ~100/s); the leg was
        // simply running a second behind the house clock, so the `sync=true`
        // sink's own back-pressure throttled ARRIVALS at its pad to the rate it
        // presented, and the frames that never made it were QoS-dropped in
        // `videoconvert` — upstream of the sink, so `droppedFps` stayed 0.
        const field = { achievedFps: 1, expectedFps: 50, droppedFps: 0, arrivalsFps: 1 };

        it('named it a SOURCE shortfall before retained latency was reported', () => {
            // The old attribution, kept as a test so the reason this field
            // cannot be diagnosed from fps alone stays on the record.
            expect(describeRenderLag(field).kind).toBe('source-shortfall');
        });

        it('names itself once the runner reports retained latency', () => {
            const report = describeRenderLag({
                ...field,
                retainedMs: 1350,
                budgetMs: 300,
                latenessMs: 1050,
            });
            expect(report.kind).toBe('presentation-backlog');
            expect(report.message).toBe(
                'Video running behind the house clock (1/50 fps) — holding 1350 ms against a 300 ms playout budget',
            );
            // NOT a source shortfall: nothing upstream is at fault, and a
            // rebuild is a legitimate answer where manufacturing frames is not.
            expect(report.sourceShortfall).toBe(false);
        });

        it('says so while the shed is under way', () => {
            expect(
                describeRenderLag({
                    ...field,
                    retainedMs: 1350,
                    budgetMs: 300,
                    latenessMs: 1050,
                    shedding: true,
                }).message,
            ).toContain('shedding backlog now');
        });

        it('outranks the total-stall reading — late is not stopped', () => {
            expect(
                describeRenderLag(
                    {
                        achievedFps: 0,
                        expectedFps: 50,
                        arrivalsFps: 0,
                        retainedMs: 2000,
                        budgetMs: 300,
                        latenessMs: 1700,
                    },
                    { sourceSilent: false },
                ).kind,
            ).toBe('presentation-backlog');
        });

        it('stays out of the way when the leg is INSIDE its budget', () => {
            // Negative lateness is the healthy case (the buffer reaches the
            // shed point before its slot), and it must not colour an ordinary
            // render-chain or source diagnosis.
            expect(
                describeRenderLag({
                    achievedFps: 41,
                    expectedFps: 50,
                    arrivalsFps: 50,
                    retainedMs: 210,
                    budgetMs: 300,
                    latenessMs: -90,
                }).kind,
            ).toBe('render-chain');
            expect(
                describeRenderLag({
                    achievedFps: 41,
                    expectedFps: 50,
                    arrivalsFps: 41.5,
                    retainedMs: 210,
                    budgetMs: 300,
                    latenessMs: -90,
                }).kind,
            ).toBe('source-shortfall');
        });

        it('falls back to the excess alone when only lateness is reported', () => {
            expect(describeRenderLag({ ...field, latenessMs: 1050 }).message).toContain(
                'holding 1050 ms more latency than the playout budget',
            );
        });

        it('is absent entirely on a legacy leg — no shedder, no reading', () => {
            // The runner only reports these fields when a shedder is armed, so
            // an unpaced leg and an older runner both take the old paths
            // unchanged.
            expect(describeRenderLag(field).kind).toBe('source-shortfall');
            expect(
                describeRenderLag({ achievedFps: 41, expectedFps: 50, arrivalsFps: 50 }).kind,
            ).toBe('render-chain');
        });
    });
});

describe('shouldWarnRenderLag', () => {
    const now = 500_000;

    it('warns on the ok→degraded edge, whatever the timestamps say', () => {
        expect(shouldWarnRenderLag({ active: false, lastWarnAt: 0, now })).toBe(true);
        expect(shouldWarnRenderLag({ active: false, lastWarnAt: now - 1, now })).toBe(true);
    });

    it('stays quiet through a brief transient — no spam between the edges', () => {
        // Lag events arrive every RENDER_WATCH_WINDOW_MS (2 s). A blip that
        // recovers inside the minute must cost exactly the one edge line.
        for (let t = 2_000; t < RENDER_LAG_REEMIT_MS; t += 2_000) {
            expect(shouldWarnRenderLag({ active: true, lastWarnAt: now, now: now + t })).toBe(
                false,
            );
        }
    });

    it('re-states a condition that persists, once per re-emit window', () => {
        // The field case: 0 achieved fps with the chain still nominally live
        // and no `recovered` event ever coming (Pi 400, 2026-08-18, 12 h silent).
        expect(
            shouldWarnRenderLag({ active: true, lastWarnAt: now, now: now + RENDER_LAG_REEMIT_MS }),
        ).toBe(true);
        expect(
            shouldWarnRenderLag({
                active: true,
                lastWarnAt: now,
                now: now + RENDER_LAG_REEMIT_MS * 10,
            }),
        ).toBe(true);
    });

    it('re-emits on a fixed cadence over a long dead-chain episode', () => {
        // Drive it exactly as the module does — every 2 s event, the latch
        // armed throughout, the timestamp advanced only when it warns.
        let lastWarnAt = now;
        let warnings = 0;
        for (let t = 2_000; t <= 3_600_000; t += 2_000) {
            if (shouldWarnRenderLag({ active: true, lastWarnAt, now: now + t })) {
                warnings += 1;
                lastWarnAt = now + t;
            }
        }
        expect(warnings).toBe(60); // one a minute over the hour, not 1800 lines
    });

    it('warns when the latch is armed but no warning was ever timestamped', () => {
        expect(shouldWarnRenderLag({ active: true, lastWarnAt: 0, now })).toBe(true);
    });

    it('measures the window on the caller’s clock, not the wall clock', () => {
        // Boot-relative on both sides (see RenderLagWarnInput.now): an NTP step
        // must not be able to silence the re-emit for hours.
        const bootNow = 42_000;
        expect(
            shouldWarnRenderLag({ active: true, lastWarnAt: bootNow - 1_000, now: bootNow }),
        ).toBe(false);
        expect(
            shouldWarnRenderLag({
                active: true,
                lastWarnAt: bootNow - RENDER_LAG_REEMIT_MS,
                now: bootNow,
            }),
        ).toBe(true);
    });
});

describe('shouldWarnSilentChain', () => {
    const now = 500_000;
    // A live episode that has just warned and just seen an event.
    const fresh = { active: true, lastEventAt: now, lastWarnAt: now, now };

    it('says nothing outside an episode — a stray tick is not a warning', () => {
        expect(shouldWarnSilentChain({ ...fresh, active: false })).toBe(false);
        expect(
            shouldWarnSilentChain({
                active: false,
                lastEventAt: 0,
                lastWarnAt: 0,
                now,
            }),
        ).toBe(false);
    });

    it('stays out of the event-driven path\u2019s way while events flow', () => {
        // Events every 2 s and a warning a minute: the timer must add nothing.
        for (let t = 0; t <= RENDER_LAG_REEMIT_MS * 3; t += RENDER_LAG_SILENT_TICK_MS) {
            const at = now + t;
            const lastEventAt = at - 2_000; // an event 2 s ago, as designed
            const lastWarnAt = now + Math.floor(t / RENDER_LAG_REEMIT_MS) * RENDER_LAG_REEMIT_MS;
            expect(shouldWarnSilentChain({ active: true, lastEventAt, lastWarnAt, now: at })).toBe(
                false,
            );
        }
    });

    it('waits for real silence, not a late tick', () => {
        // One missed window is scheduling; RENDER_LAG_SILENT_TICK_MS of nothing
        // is the reporter having stopped.
        expect(
            shouldWarnSilentChain({
                active: true,
                lastEventAt: now,
                lastWarnAt: now - RENDER_LAG_REEMIT_MS,
                now: now + RENDER_LAG_SILENT_TICK_MS - 1,
            }),
        ).toBe(false);
        expect(
            shouldWarnSilentChain({
                active: true,
                lastEventAt: now,
                lastWarnAt: now - RENDER_LAG_REEMIT_MS,
                now: now + RENDER_LAG_SILENT_TICK_MS,
            }),
        ).toBe(true);
    });

    it('never doubles up on a minute the event path already logged', () => {
        // Silent for ages, but a warning went out 30 s ago: not due yet.
        expect(
            shouldWarnSilentChain({
                active: true,
                lastEventAt: now - 120_000,
                lastWarnAt: now - 30_000,
                now,
            }),
        ).toBe(false);
    });

    it('re-states the episode on the reemit cadence once the runner goes quiet', () => {
        expect(
            shouldWarnSilentChain({
                active: true,
                lastEventAt: now - 120_000,
                lastWarnAt: now - RENDER_LAG_REEMIT_MS,
                now,
            }),
        ).toBe(true);
    });

    it('reproduces the on-target stall: 150 s of silence yields a line a minute', () => {
        // Pi 400, weston SIGSTOP 150 s: lag edge at t=0, the runner's reporter
        // stops with the renders, ticks every RENDER_LAG_SILENT_TICK_MS.
        // Before the fix this window carried exactly ONE line, at onset.
        const t0 = now;
        let lastWarnAt = t0; // the edge warning
        const warnedAt: number[] = [];
        for (let t = RENDER_LAG_SILENT_TICK_MS; t <= 150_000; t += RENDER_LAG_SILENT_TICK_MS) {
            const at = t0 + t;
            if (shouldWarnSilentChain({ active: true, lastEventAt: t0, lastWarnAt, now: at })) {
                warnedAt.push(t);
                lastWarnAt = at;
            }
        }
        expect(warnedAt).toEqual([60_000, 120_000]);
    });

    it('measures both windows on the caller\u2019s clock, not the wall clock', () => {
        // Boot-relative (see SilentChainInput.now): an NTP step must not be
        // able to mute a dead chain for hours, nor spam it.
        const bootNow = 42_000;
        expect(
            shouldWarnSilentChain({
                active: true,
                lastEventAt: bootNow - RENDER_LAG_REEMIT_MS,
                lastWarnAt: bootNow - RENDER_LAG_REEMIT_MS,
                now: bootNow,
            }),
        ).toBe(true);
    });
});

describe('shouldSelfHealAfterResume', () => {
    const now = 1_000_000;
    const base = { sourceShortfall: false, healDone: false, lastStallResumeAt: now - 10_000, now };

    it('heals a render lag inside the post-resume window', () => {
        expect(shouldSelfHealAfterResume(base)).toBe(true);
    });

    it('spends the free rebuild exactly once per resume', () => {
        expect(shouldSelfHealAfterResume({ ...base, healDone: true })).toBe(false);
    });

    it('does not heal a source shortfall — a rebuild cannot manufacture frames', () => {
        expect(shouldSelfHealAfterResume({ ...base, sourceShortfall: true })).toBe(false);
    });

    it('does not heal without a resume to attribute the lag to', () => {
        expect(shouldSelfHealAfterResume({ ...base, lastStallResumeAt: 0 })).toBe(false);
    });

    it('does not heal once the window has elapsed', () => {
        expect(
            shouldSelfHealAfterResume({
                ...base,
                lastStallResumeAt: now - POST_RESUME_HEAL_WINDOW_MS,
            }),
        ).toBe(false);
    });

    it('measures the window on the caller’s clock, not the wall clock', () => {
        // Both sides come from `bootNowMs` (uptime, small numbers). There is no
        // wall-clock default precisely so a wall-clock `lastStallResumeAt`
        // can't silently be compared against a boot-relative "now" — the Pi has
        // no RTC and NTP steps the wall clock by hours mid-session.
        const bootNow = 42_000;
        expect(
            shouldSelfHealAfterResume({
                sourceShortfall: false,
                healDone: false,
                lastStallResumeAt: bootNow - 1_000,
                now: bootNow,
            }),
        ).toBe(true);
    });
});

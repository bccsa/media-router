import { describe, it, expect } from 'vitest';
import {
    describeRenderLag,
    POST_RESUME_HEAL_WINDOW_MS,
    shouldSelfHealAfterResume,
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

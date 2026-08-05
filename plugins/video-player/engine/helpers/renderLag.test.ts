import { describe, it, expect } from 'vitest';
import {
    describeRenderLag,
    POST_RESUME_HEAL_WINDOW_MS,
    shouldSelfHealAfterResume,
} from './renderLag.js';

describe('describeRenderLag', () => {
    it('blames the render chain when the sink presents fewer frames than arrive', () => {
        expect(describeRenderLag({ achievedFps: 41, expectedFps: 50, arrivalsFps: 50 })).toEqual({
            sourceShortfall: false,
            message:
                "Video output can't keep up (41/50 fps) — lower the stream or display resolution",
        });
    });

    it('blames the source when presented ≈ arrivals (within the 1 fps slack)', () => {
        // Field case 2026-08-01: the link dips, the display is fine. Telling
        // the operator to lower the resolution would be wrong advice.
        expect(describeRenderLag({ achievedFps: 41, expectedFps: 50, arrivalsFps: 41.5 })).toEqual({
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

import { describe, it, expect } from 'vitest';
import { cogNeedingRestack, COG_SURFACE_GRACE_MS } from './cogRestack.js';

describe('cogNeedingRestack', () => {
    const watchStartedAt = 1_000_000;
    const base = {
        display: 'HDMI-A-1',
        watchStartedAt,
        lastRestackPid: undefined as number | undefined,
    };

    it('names a cog whose process started after our watch began', () => {
        // Field case 2026-08-02 (monitor power-cycle): compositor restart
        // respawned cog AFTER the video pipeline rebuilt, so its surface
        // covered the video with the pipeline still happily decoding.
        expect(
            cogNeedingRestack({ ...base, findPid: () => 500, startMs: () => watchStartedAt + 500 }),
        ).toBe(500);
    });

    it('names a cog that started inside the surface-grace window before us', () => {
        // The PROCESS predates the pipeline but its page — and so its surface —
        // can still map after ours.
        expect(
            cogNeedingRestack({
                ...base,
                findPid: () => 500,
                startMs: () => watchStartedAt - 5_000,
            }),
        ).toBe(500);
    });

    it('leaves a cog well older than the watch alone (we are already on top)', () => {
        expect(
            cogNeedingRestack({
                ...base,
                findPid: () => 500,
                startMs: () => watchStartedAt - COG_SURFACE_GRACE_MS,
            }),
        ).toBeUndefined();
    });

    it('is latched by the caller: the PID it already restacked for is skipped', () => {
        expect(
            cogNeedingRestack({
                ...base,
                lastRestackPid: 500,
                findPid: () => 500,
                startMs: () => watchStartedAt + 500,
            }),
        ).toBeUndefined();
    });

    it('names a NEW cog incarnation even after a latched one', () => {
        expect(
            cogNeedingRestack({
                ...base,
                lastRestackPid: 500,
                findPid: () => 501,
                startMs: () => watchStartedAt + 900,
            }),
        ).toBe(501);
    });

    it('waits when no cog is running on the output (mid-restart)', () => {
        expect(
            cogNeedingRestack({ ...base, findPid: () => undefined, startMs: () => 0 }),
        ).toBeUndefined();
    });

    it('waits when the start time cannot be read (process raced an exit)', () => {
        expect(
            cogNeedingRestack({ ...base, findPid: () => 500, startMs: () => undefined }),
        ).toBeUndefined();
    });

    it('does nothing without a display — an unpinned watch matches no cog', () => {
        let looked = false;
        expect(
            cogNeedingRestack({
                ...base,
                display: '',
                findPid: () => {
                    looked = true;
                    return 500;
                },
                startMs: () => watchStartedAt + 500,
            }),
        ).toBeUndefined();
        expect(looked).toBe(false);
    });

    it('falls back to the real /proc readers when none are injected', () => {
        // No cog is running under this test process, so the real readers must
        // simply come back empty rather than throwing.
        expect(cogNeedingRestack({ ...base })).toBeUndefined();
    });
});

import { describe, it, expect, vi } from 'vitest';
import { pollResumeSignal, RESUME_STABLE_POLLS, type ResumePollState } from './busResume.js';

const noProbe = vi.fn(async () => false);

describe('pollResumeSignal — tap mode', () => {
    const tap = (bytes: number | undefined, state: ResumePollState) =>
        pollResumeSignal({
            tapActive: true,
            state,
            readTapBytes: async () => bytes,
            socketPath: '/tmp/never-probed.sock',
            probeSocket: noProbe,
        });

    it('the first tick only baselines — there is nothing to compare against', async () => {
        const result = await tap(1000, { lastBytes: undefined, streak: 0 });
        expect(result).toEqual({ lastBytes: 1000, streak: 0, resumed: false });
    });

    it('counts a poll as flowing only when the byte counter ADVANCES', async () => {
        expect(await tap(1000, { lastBytes: 1000, streak: 0 })).toMatchObject({ streak: 0 });
        expect(await tap(2000, { lastBytes: 1000, streak: 0 })).toMatchObject({
            streak: 1,
            lastBytes: 2000,
        });
    });

    it('resumes only after a stable streak, not on the first sign of bytes', async () => {
        // Field case 2026-08-02: rebuilding on the first advance caught a
        // still-churning source and ran degraded until a manual restart.
        let state: ResumePollState = { lastBytes: 1000, streak: 0 };
        for (let i = 1; i < RESUME_STABLE_POLLS; i++) {
            const r = await tap(1000 + i * 1000, state);
            expect(r.resumed).toBe(false);
            state = r;
        }
        const last = await tap(1000 + RESUME_STABLE_POLLS * 1000, state);
        expect(last.resumed).toBe(true);
        expect(last.streak).toBe(RESUME_STABLE_POLLS);
    });

    it('a flat poll mid-streak resets the stability gate', async () => {
        const flat = await tap(3000, { lastBytes: 3000, streak: RESUME_STABLE_POLLS - 1 });
        expect(flat).toMatchObject({ streak: 0, resumed: false });
    });

    it('keeps the previous sample when the counter is unreadable', async () => {
        const result = await tap(undefined, { lastBytes: 4242, streak: 2 });
        expect(result).toEqual({ lastBytes: 4242, streak: 0, resumed: false });
    });

    it('never touches the socket probe in tap mode', async () => {
        await tap(1000, { lastBytes: 500, streak: 0 });
        expect(noProbe).not.toHaveBeenCalled();
    });
});

describe('pollResumeSignal — no-tap mode', () => {
    const probeOnce = (answers: boolean) =>
        pollResumeSignal({
            tapActive: false,
            state: { lastBytes: undefined, streak: 0 },
            readTapBytes: async () => {
                throw new Error('tap must not be read in no-tap mode');
            },
            socketPath: '/tmp/mr-bus-5500-abc.sock',
            probeSocket: async () => answers,
        });

    it('counts a socket that answers as flowing', async () => {
        expect(await probeOnce(true)).toMatchObject({ streak: 1, resumed: false });
    });

    it('counts a dead socket as not flowing', async () => {
        expect(await probeOnce(false)).toMatchObject({ streak: 0, resumed: false });
    });

    it('applies the same stability gate as tap mode', async () => {
        const result = await pollResumeSignal({
            tapActive: false,
            state: { lastBytes: undefined, streak: RESUME_STABLE_POLLS - 1 },
            readTapBytes: async () => undefined,
            socketPath: '/tmp/mr-bus-5500-abc.sock',
            probeSocket: async () => true,
        });
        expect(result.resumed).toBe(true);
    });

    it('never probes when the source has no socket path', async () => {
        const probeSocket = vi.fn(async () => true);
        const result = await pollResumeSignal({
            tapActive: false,
            state: { lastBytes: undefined, streak: 0 },
            readTapBytes: async () => undefined,
            socketPath: undefined,
            probeSocket,
        });
        expect(probeSocket).not.toHaveBeenCalled();
        expect(result).toEqual({ lastBytes: undefined, streak: 0, resumed: false });
    });
});

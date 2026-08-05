import { describe, it, expect, afterEach } from 'vitest';
import {
    DecoderDemotions,
    DEFAULT_DEMOTION_TTL_MS,
    DEMOTION_TTL_ENV_VAR,
    resolveDemotionTtlMs,
} from './decoderDemotions.js';
import {
    DECODEBIN_SELECTION,
    DECODER_ELEMENTS,
    selectDecoder,
    type DecoderAvailability,
    type DecoderSelection,
} from './decoderSelection.js';

/** Everything installed — the Pi 5 / full-GStreamer case. */
const ALL: DecoderAvailability = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));

const TTL = 300_000;
/** A wall-clock-ish base so `now - demotedAt` reads like real timestamps. */
const T0 = 1_700_000_000_000;

function rung(codec: string, demoted: ReadonlySet<string> = new Set()): DecoderSelection {
    return selectDecoder({ codec, available: ALL, demoted });
}

describe('resolveDemotionTtlMs', () => {
    afterEach(() => {
        delete process.env[DEMOTION_TTL_ENV_VAR];
    });

    it('defaults to 5 minutes with no override', () => {
        expect(resolveDemotionTtlMs(undefined)).toBe(DEFAULT_DEMOTION_TTL_MS);
        expect(DEFAULT_DEMOTION_TTL_MS).toBe(300_000);
    });

    it('takes the override from the environment', () => {
        process.env[DEMOTION_TTL_ENV_VAR] = '60000';
        expect(resolveDemotionTtlMs()).toBe(60_000);
    });

    it('reads 0 as the opt-out — demotions last the whole session again', () => {
        expect(resolveDemotionTtlMs('0')).toBe(0);
    });

    it('falls back to the default on junk, empty and negative values', () => {
        // A typo'd env var must not silently disable the age-out.
        for (const raw of ['', '   ', 'five minutes', 'NaN', '-1', '-30000']) {
            expect(resolveDemotionTtlMs(raw)).toBe(DEFAULT_DEMOTION_TTL_MS);
        }
    });
});

describe('DecoderDemotions', () => {
    describe('active', () => {
        it('holds a demotion for the TTL and drops it after', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            expect([...d.active(T0, TTL)]).toEqual(['v4l2slh265dec']);
            expect([...d.active(T0 + TTL - 1, TTL)]).toEqual(['v4l2slh265dec']);
            // Exactly at the deadline it is gone — the retry timer is armed for
            // this instant and must not find it one tick short of expired.
            expect([...d.active(T0 + TTL, TTL)]).toEqual([]);
            expect([...d.active(T0 + TTL * 10, TTL)]).toEqual([]);
        });

        it('ages each demotion out on its own clock', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2h264dec', T0);
            d.demote('avdec_h264', T0 + 60_000);
            expect([...d.active(T0 + TTL, TTL)]).toEqual(['avdec_h264']);
            expect([...d.active(T0 + TTL + 60_000, TTL)]).toEqual([]);
        });

        it('keeps failure order — the rank mask reads as a history', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2h264dec', T0);
            d.demote('avdec_h264', T0 + 1000);
            expect([...d.active(T0 + 2000, TTL)]).toEqual(['v4l2h264dec', 'avdec_h264']);
        });

        it('never ages out with the TTL disabled', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            expect([...d.active(T0 + 86_400_000, 0)]).toEqual(['v4l2slh265dec']);
        });

        it('re-demotion restarts the clock — the retry cadence IS the TTL', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            // Retried at the deadline, failed again straight away.
            d.demote('v4l2slh265dec', T0 + TTL);
            expect([...d.active(T0 + TTL + 1, TTL)]).toEqual(['v4l2slh265dec']);
            expect([...d.active(T0 + TTL * 2, TTL)]).toEqual([]);
        });
    });

    describe('prune', () => {
        it('returns and removes only the aged-out demotions', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2h264dec', T0);
            d.demote('avdec_h264', T0 + 60_000);
            expect(d.prune(T0 + TTL, TTL)).toEqual(['v4l2h264dec']);
            expect(d.prune(T0 + TTL, TTL)).toEqual([]);
            expect([...d.active(T0 + TTL, TTL)]).toEqual(['avdec_h264']);
        });

        it('leaves only demotions with a deadline still ahead', () => {
            // What lets the retry re-arm without spinning: after a prune every
            // surviving demotion expires strictly in the future.
            const d = new DecoderDemotions();
            d.demote('v4l2h264dec', T0);
            d.demote('avdec_h264', T0 + 60_000);
            const now = T0 + TTL;
            d.prune(now, TTL);
            expect(d.retryAt('h264', DECODEBIN_SELECTION, TTL)!).toBeGreaterThan(now);
        });
    });

    describe('retryAt', () => {
        it('is the deadline of the demoted rung above the one we are running', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            const software = rung('h265', new Set(['v4l2slh265dec']));
            expect(software.id).toBe('avdec_h265');
            expect(d.retryAt('h265', software, TTL)).toBe(T0 + TTL);
        });

        it('is undefined while we are already running the best rung', () => {
            const d = new DecoderDemotions();
            d.demote('avdec_h265', T0);
            // Software demoted, hardware running: nothing above us to go back to.
            expect(d.retryAt('h265', rung('h265'), TTL)).toBeUndefined();
        });

        it('takes the EARLIEST deadline when the whole ladder is demoted', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2h264dec', T0);
            d.demote('avdec_h264', T0 + 60_000);
            // decodebin3 is below every rung, so both count — and the first
            // retry is the one that gets the hardware rung back.
            expect(d.retryAt('h264', DECODEBIN_SELECTION, TTL)).toBe(T0 + TTL);
        });

        it('ignores demotions on another codec’s ladder', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            expect(d.retryAt('h264', DECODEBIN_SELECTION, TTL)).toBeUndefined();
        });

        it('is undefined with no ladder, no codec, or the TTL disabled', () => {
            const d = new DecoderDemotions();
            d.demote('v4l2slh265dec', T0);
            const software = rung('h265', new Set(['v4l2slh265dec']));
            expect(d.retryAt('mpeg2', software, TTL)).toBeUndefined();
            expect(d.retryAt(undefined, software, TTL)).toBeUndefined();
            expect(d.retryAt('h265', software, 0)).toBeUndefined();
        });
    });

    it('clear drops everything (engine-session reset)', () => {
        const d = new DecoderDemotions();
        d.demote('v4l2slh265dec', T0);
        d.clear();
        expect([...d.active(T0, TTL)]).toEqual([]);
        expect(d.retryAt('h265', DECODEBIN_SELECTION, TTL)).toBeUndefined();
    });
});

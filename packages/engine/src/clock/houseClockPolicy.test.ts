import { describe, it, expect } from 'vitest';
import {
    decide,
    isSynced,
    parseClockLine,
    qualifies,
    type ClockSample,
    type Latched,
} from './houseClockPolicy.js';

const S = 1_000_000_000n;
const E0 = 1_789_775_770n * S; // a real-sized TAI − MONO, beyond 2^53

function sample(over: Partial<ClockSample> = {}): ClockSample {
    return {
        monoNs: 2_103_103n * S,
        eNs: E0,
        bracketNs: 74,
        synced: true,
        taiOffsetS: 37,
        estErrorUs: 1200,
        maxErrorUs: 5000,
        freqPpm: 3.5,
        status: 0x2001,
        leap: 'ok',
        ...over,
    };
}

const running = { waitExpired: false, stepped: false, settleExpired: false };
const expired = { waitExpired: true, stepped: false, settleExpired: false };
const stepped = { ...expired, stepped: true };
const traceable: Latched = { eNs: E0, traceable: true };
const untraceable: Latched = { eNs: E0, traceable: false };

describe('qualifies', () => {
    it('needs the kernel synced and a set TAI offset', () => {
        expect(qualifies(sample())).toBe(true);
        expect(qualifies(sample({ synced: false }))).toBe(false);
        expect(qualifies(sample({ taiOffsetS: 0 }))).toBe(false);
        // 10 s floor, not 37: a future leap second must still pass.
        expect(qualifies(sample({ taiOffsetS: 10 }))).toBe(true);
        expect(qualifies(sample({ taiOffsetS: 38 }))).toBe(true);
        expect(qualifies(sample({ taiOffsetS: 9 }))).toBe(false);
    });

    it('a daemon-asserted bound too: STA_UNSYNC clear at maxerror 16 s is not sync', () => {
        // linuxptp's set_leap(0) at ptp4l/phc2sys start, measured on .108 and .103.
        const falseWindow = sample({ synced: true, maxErrorUs: 16_000_000 });
        expect(isSynced(falseWindow)).toBe(false);
        expect(qualifies(falseWindow)).toBe(false);
        expect(qualifies(sample({ maxErrorUs: 999_999 }))).toBe(true);
        expect(qualifies(sample({ maxErrorUs: 1_000_000 }))).toBe(false);
        expect(isSynced(sample({ maxErrorUs: 0 }))).toBe(true); // locked phc2sys resets it to 0
        expect(isSynced(sample({ synced: false, maxErrorUs: 0 }))).toBe(false);
    });
});

describe('decide — the epoch decision table', () => {
    it('start synced → latch(start)', () => {
        expect(decide(null, sample(), running)).toEqual({ kind: 'latch', reason: 'start' });
    });

    it('start never synced → waits, then latch(timeout) once the 30 s wait ran out', () => {
        const unsynced = sample({ synced: false, taiOffsetS: 0 });
        expect(decide(null, unsynced, running)).toEqual({ kind: 'none' });
        expect(decide(null, unsynced, expired)).toEqual({ kind: 'latch', reason: 'timeout' });
        // No sample at all yet: nothing to latch, the first sample will.
        expect(decide(null, null, expired)).toEqual({ kind: 'none' });
    });

    it('sync after timeout with E moved 37 s (TAI set late) → relatch(sync)', () => {
        const late = sample({ eNs: E0 + 37n * S });
        expect(decide(untraceable, late, running)).toEqual({ kind: 'relatch', reason: 'sync' });
    });

    it('sync after timeout with E unchanged → traceable(true), no seq bump', () => {
        expect(decide(untraceable, sample({ eNs: E0 + 3_000n }), running)).toEqual({
            kind: 'traceable',
            traceable: true,
        });
    });

    it('step +2 s → relatch(step)', () => {
        const after = sample({ eNs: E0 + 2n * S });
        expect(decide(traceable, after, stepped)).toEqual({
            kind: 'relatch',
            reason: 'step',
        });
    });

    it('REALTIME step with E unchanged (leap insert) → none', () => {
        // REALTIME repeats a second and the TAI offset goes 37 → 38; TAI, so E, does not move.
        const leap = sample({ eNs: E0 + 2_000n, taiOffsetS: 38 });
        expect(decide(traceable, leap, stepped)).toEqual({
            kind: 'none',
            stepIgnored: true,
        });
    });

    it('divergence 1.5 ms → relatch(divergence)', () => {
        expect(decide(traceable, sample({ eNs: E0 + 1_500_000n }), expired)).toEqual({
            kind: 'relatch',
            reason: 'divergence',
        });
        expect(decide(traceable, sample({ eNs: E0 - 1_500_000n }), expired)).toEqual({
            kind: 'relatch',
            reason: 'divergence',
        });
    });

    it('divergence 0.2 ms → none', () => {
        expect(decide(traceable, sample({ eNs: E0 + 200_000n }), expired)).toEqual({
            kind: 'none',
        });
    });

    it('loss of sync after latch → traceable(false), E kept', () => {
        expect(decide(traceable, sample({ synced: false }), expired)).toEqual({
            kind: 'traceable',
            traceable: false,
        });
    });

    it('a move while untraceable and unsynced settles; at the cap it re-latches', () => {
        const after = sample({ eNs: E0 + 2n * S, synced: false });
        expect(decide(untraceable, after, stepped)).toEqual({ kind: 'settle' });
        expect(decide(untraceable, after, expired)).toEqual({ kind: 'settle' });
        const capped = { ...stepped, settleExpired: true };
        expect(decide(untraceable, after, capped)).toEqual({ kind: 'relatch', reason: 'step' });
        // TAI written by hand with no daemon: no step line, so a divergence.
        const tai = sample({ eNs: E0 + 37n * S, synced: false });
        expect(decide(untraceable, tai, { ...expired, settleExpired: true })).toEqual({
            kind: 'relatch',
            reason: 'divergence',
        });
    });

    it('a settle ends on sync: relatch(step) when a step began it, else relatch(sync)', () => {
        const synced = sample({ eNs: E0 + 37n * S });
        expect(decide(untraceable, synced, stepped)).toEqual({ kind: 'relatch', reason: 'step' });
        expect(decide(untraceable, synced, expired)).toEqual({ kind: 'relatch', reason: 'sync' });
    });

    it('a move while traceable never settles: it re-latches at once', () => {
        const after = sample({ eNs: E0 + 2n * S, synced: false });
        expect(decide(traceable, after, stepped)).toEqual({ kind: 'relatch', reason: 'step' });
    });
});

describe('parseClockLine — the mr-clockstate JSON lines', () => {
    it('parses a sample with bigint-safe ns strings', () => {
        const line =
            '{"type":"sample","monoNs":"2103103813119540","eNs":"1789775770559436728","bracketNs":74,' +
            '"synced":true,"taiOffsetS":0,"estErrorUs":0,"maxErrorUs":780500,"freqPpm":3.479,' +
            '"status":24577,"leap":"ok"}';
        const msg = parseClockLine(line);
        expect(msg).toEqual({
            type: 'sample',
            sample: {
                monoNs: 2103103813119540n,
                eNs: 1789775770559436728n,
                bracketNs: 74,
                synced: true,
                taiOffsetS: 0,
                estErrorUs: 0,
                maxErrorUs: 780500,
                freqPpm: 3.479,
                status: 24577,
                leap: 'ok',
            },
        });
    });

    it('parses a step line', () => {
        expect(parseClockLine('{"type":"step","monoNs":"12345"}')).toEqual({
            type: 'step',
            monoNs: 12345n,
        });
    });

    it('ignores noise and malformed lines', () => {
        expect(parseClockLine('mr-clockstate: no timerfd step watch')).toBeNull();
        expect(parseClockLine('{"type":"other"}')).toBeNull();
        expect(parseClockLine('{"type":"sample","monoNs":"x","eNs":"1"}')).toBeNull();
    });
});

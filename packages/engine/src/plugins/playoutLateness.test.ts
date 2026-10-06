import { describe, it, expect } from 'vitest';
import {
    LateAudioWatch,
    lateAudioClearedMessage,
    lateAudioMessage,
    readLatenessWindow,
    timingStatus,
    type LatenessWindow,
} from './playoutLateness.js';

/** A 10 s window of .24's 302M headphone: budget 80 = ts-offset 0 + latency 80. */
const win = (o: Partial<LatenessWindow> = {}): LatenessWindow => ({
    mediaMs: 10_000,
    lateMs: 0,
    maxLatenessMs: -62,
    minLatenessMs: -95,
    budgetMs: 80,
    latencyMs: 80,
    ...o,
});
/** lipSync 0 on .24 (2026-10-04): 23.7 % of the audio lost, health "ok". */
const LATE = win({ lateMs: 2370, maxLatenessMs: 118.6, minLatenessMs: -70 });
const CLEAN = win();
/** A muted leg (volume 0 → every buffer GAP): the runners still close its
 *  windows, with no audio measured in them. */
const MUTED = win({ mediaMs: 0, maxLatenessMs: 0, minLatenessMs: 0 });
/** The .24 decoder after its source restarted: every buffer ~588 s late. */
const LOST = win({
    lateMs: 10_000,
    maxLatenessMs: 587_803.3,
    minLatenessMs: 587_781.8,
    budgetMs: 160,
});

describe('readLatenessWindow', () => {
    it('takes the runner payload as it is', () => {
        expect(readLatenessWindow(LATE)).toEqual(LATE);
    });

    it('rejects a malformed payload (an older or newer runner)', () => {
        for (const p of [
            null,
            undefined,
            'late',
            {},
            { ...LATE, minLatenessMs: undefined },
            { ...LATE, lateMs: Number.NaN },
            { ...LATE, budgetMs: '80' },
        ]) {
            expect(readLatenessWindow(p)).toBeNull();
        }
    });
});

describe('LateAudioWatch', () => {
    it('one late window never warns — a start-up step or an onset after silence', () => {
        const w = new LateAudioWatch();
        expect(w.offer(LATE)).toBeNull();
        expect(w.offer(CLEAN)).toBeNull();
        expect(w.offer(LATE)).toBeNull();
    });

    it('trips on the second late window in a row, then keeps the message current', () => {
        const w = new LateAudioWatch();
        w.offer(LATE);
        expect(w.offer(LATE)).toEqual({ message: lateAudioMessage(LATE), tripped: true });
        const worse = win({ lateMs: 4000, maxLatenessMs: 160 });
        expect(w.offer(worse)).toEqual({ message: lateAudioMessage(worse), tripped: false });
    });

    it('stays latched through intermittent loss and clears once, after a clean minute', () => {
        const w = new LateAudioWatch();
        w.offer(LATE);
        w.offer(LATE);
        for (let i = 0; i < 5; i++) expect(w.offer(CLEAN)).toBeNull();
        expect(w.offer(LATE)).toMatchObject({ tripped: false });
        for (let i = 0; i < 5; i++) expect(w.offer(CLEAN)).toBeNull();
        expect(w.offer(CLEAN)).toBe('clear');
        expect(w.offer(CLEAN)).toBeNull();
        expect(w.offer(LATE)).toBeNull(); // a fresh streak has to be earned again
    });

    it('a window with no audio (a muted leg) clears at once and breaks a late streak', () => {
        const w = new LateAudioWatch();
        w.offer(LATE);
        expect(w.offer(MUTED)).toBeNull(); // not tripped: nothing to clear
        expect(w.offer(LATE)).toBeNull(); // the streak starts over
        expect(w.offer(LATE)).toMatchObject({ tripped: true });
        expect(w.offer(MUTED)).toBe('clear'); // no waiting out a clean minute
        expect(w.offer(MUTED)).toBeNull();
        expect(w.offer(LATE)).toBeNull(); // unmuted: earned again
    });

    it('reset forgets the streak — a new incarnation earns the warning again', () => {
        const w = new LateAudioWatch();
        w.offer(LATE);
        w.reset();
        expect(w.offer(LATE)).toBeNull();
        w.offer(LATE);
        w.reset();
        expect(w.offer(CLEAN)).toBeNull(); // nothing left to clear
    });
});

describe('lateAudioMessage', () => {
    it('budget starvation names the worst lateness and asks for worst + 40 ms', () => {
        expect(lateAudioMessage(LATE)).toBe(
            'Audio reaches the output after its playout time and plays as silence (worst +119 ms, ' +
                '≈23.7 % late in the last 10 s) — needs ≥ 159 ms more budget ' +
                "(route Playout Offset or this output's trim)",
        );
    });

    it('a lost timeline is named as such, with no budget advice', () => {
        expect(lateAudioMessage(LOST)).toBe(
            'Audio timeline 588 s behind the house clock, all audio discarded — ' +
                'upstream timeline fault, not a budget problem',
        );
    });

    it('a timeline step inside the window gets no budget advice either', () => {
        const message = lateAudioMessage(
            win({ lateMs: 1060, maxLatenessMs: 587_782, minLatenessMs: -80 }),
        );
        expect(message).toBe(
            'Audio timeline 588 s behind the house clock — upstream timeline fault, not a budget problem',
        );
    });
});

describe('lateAudioClearedMessage', () => {
    it('says why the warning ended: a clean minute, or no audio at all', () => {
        expect(lateAudioClearedMessage(CLEAN)).toBe('Late audio cleared — on time for a minute');
        expect(lateAudioClearedMessage(MUTED)).toBe(
            'Late audio cleared — no audio in the last 10 s (muted or no source)',
        );
    });
});

describe('timingStatus', () => {
    it('shows the window: late share (estimate), worst lateness, budget and sink latency', () => {
        expect(timingStatus(LATE)).toEqual({
            latePct: 23.7,
            worstMs: 119,
            budgetMs: 80,
            latencyMs: 80,
        });
    });

    it('a window with no audio in it (a muted leg) shows nothing', () => {
        expect(timingStatus(MUTED)).toBeNull();
    });
});

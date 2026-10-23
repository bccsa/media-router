import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLiveWrites, type LiveTarget } from './liveWrites';

const A: LiveTarget = { engineId: 'eng-1', moduleId: 'a', key: 'volume' };
const B: LiveTarget = { engineId: 'eng-1', moduleId: 'b', key: 'volume' };
const A_ON_ENG2: LiveTarget = { engineId: 'eng-2', moduleId: 'a', key: 'volume' };
const A_GAIN: LiveTarget = { engineId: 'eng-1', moduleId: 'a', key: 'gain' };

/** The writes made, as `module.key = value`, engine prefixed. */
function setup(throttleMs = 50) {
    const sent: string[] = [];
    const live = createLiveWrites(
        (t, v) => sent.push(`${t.engineId}/${t.moduleId}.${t.key}=${v}`),
        throttleMs,
    );
    return { live, sent };
}

describe('createLiveWrites: a held value goes where it was made (B-106)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('throttle: the first at once, the latest of the window when it closes, then at once again', () => {
        const { live, sent } = setup();
        live.throttle(A, 1);
        live.throttle(A, 2);
        live.throttle(A, 3);
        expect(sent).toEqual(['eng-1/a.volume=1']);
        vi.advanceTimersByTime(50);
        expect(sent).toEqual(['eng-1/a.volume=1', 'eng-1/a.volume=3']);
        live.throttle(A, 4);
        expect(sent.at(-1)).toBe('eng-1/a.volume=4');
    });

    it('throttle: a window with nothing held sends nothing when it closes', () => {
        const { live, sent } = setup();
        live.throttle(A, 1);
        vi.advanceTimersByTime(200);
        expect(sent).toEqual(['eng-1/a.volume=1']);
    });

    it("throttle: another module's value inside a window is its own write; each held value goes to its module", () => {
        const { live, sent } = setup(100);
        live.throttle(A, 10);
        live.throttle(A, 20);
        live.throttle(B, 30);
        live.throttle(B, 40);
        expect(sent).toEqual(['eng-1/a.volume=10', 'eng-1/b.volume=30']);
        vi.advanceTimersByTime(100);
        expect(sent).toEqual([
            'eng-1/a.volume=10',
            'eng-1/b.volume=30',
            'eng-1/a.volume=20',
            'eng-1/b.volume=40',
        ]);
    });

    it('throttle: the same module id on another engine, and another key of the module, are other targets', () => {
        const { live, sent } = setup();
        live.throttle(A, 1);
        live.throttle(A_ON_ENG2, 2);
        live.throttle(A_GAIN, 3);
        expect(sent).toEqual(['eng-1/a.volume=1', 'eng-2/a.volume=2', 'eng-1/a.gain=3']);
    });

    it('debounce: only the last value, once it has rested; per target', () => {
        const { live, sent } = setup();
        live.debounce(A, 1, 300);
        vi.advanceTimersByTime(200);
        live.debounce(A, 2, 300);
        live.debounce(B, 7, 300);
        vi.advanceTimersByTime(299);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual(['eng-1/a.volume=2', 'eng-1/b.volume=7']);
        vi.advanceTimersByTime(1000);
        expect(sent).toHaveLength(2);
    });

    it('flush: every held and waiting value to its own target at once, and no window left open', () => {
        const { live, sent } = setup();
        live.throttle(A, 1);
        live.throttle(A, 2);
        live.debounce(A_GAIN, 5, 300);
        live.flush();
        expect(sent).toEqual(['eng-1/a.volume=1', 'eng-1/a.volume=2', 'eng-1/a.gain=5']);
        vi.advanceTimersByTime(1000);
        expect(sent).toHaveLength(3);
        live.throttle(A, 9);
        expect(sent.at(-1)).toBe('eng-1/a.volume=9');
    });
});

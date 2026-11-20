import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPS_REFUSED_CLEAR_MS, CapsRefusalLatch, decoderCapsRefusedNote } from './capsRefusal.js';

describe('decoderCapsRefusedNote', () => {
    it('names the decoder, the flow return and what to fix at the source', () => {
        const note = decoderCapsRefusedNote('v4l2h264dec');
        expect(note).toContain('v4l2h264dec');
        expect(note).toContain('not-negotiated');
        expect(note).toMatch(/colour description/);
        expect(note).toMatch(/BT\.709/);
    });
});

describe('CapsRefusalLatch', () => {
    const NOTE = decoderCapsRefusedNote('v4l2h264dec');

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports the first refusal, not the repeats', () => {
        const latch = new CapsRefusalLatch();
        expect(latch.refused(NOTE)).toBe(true);
        expect(latch.refused(NOTE)).toBe(false);
        expect(latch.refused(decoderCapsRefusedNote('v4l2slh265dec'))).toBe(true);
        expect(latch.active).toBe(decoderCapsRefusedNote('v4l2slh265dec'));
    });

    it('PLAYING with nothing latched returns nothing and arms nothing', () => {
        const latch = new CapsRefusalLatch();
        const onClear = vi.fn();
        expect(latch.playing(onClear)).toBeUndefined();
        vi.advanceTimersByTime(CAPS_REFUSED_CLEAR_MS * 2);
        expect(onClear).not.toHaveBeenCalled();
    });

    it('clears after a clean PLAYING run', () => {
        const latch = new CapsRefusalLatch();
        latch.refused(NOTE);
        const onClear = vi.fn();
        expect(latch.playing(onClear)).toBe(NOTE);
        vi.advanceTimersByTime(CAPS_REFUSED_CLEAR_MS - 1);
        expect(onClear).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onClear).toHaveBeenCalledTimes(1);
        expect(latch.active).toBeUndefined();
    });

    it('a refusal within the window cancels the clear', () => {
        const latch = new CapsRefusalLatch();
        latch.refused(NOTE);
        const onClear = vi.fn();
        latch.playing(onClear);
        vi.advanceTimersByTime(1_400);
        expect(latch.refused(NOTE)).toBe(false);
        vi.advanceTimersByTime(CAPS_REFUSED_CLEAR_MS);
        expect(onClear).not.toHaveBeenCalled();
        expect(latch.active).toBe(NOTE);
    });

    it('reset drops the note and the pending clear', () => {
        const latch = new CapsRefusalLatch();
        latch.refused(NOTE);
        const onClear = vi.fn();
        latch.playing(onClear);
        latch.reset();
        vi.advanceTimersByTime(CAPS_REFUSED_CLEAR_MS);
        expect(onClear).not.toHaveBeenCalled();
        expect(latch.active).toBeUndefined();
        expect(latch.refused(NOTE)).toBe(true);
    });
});

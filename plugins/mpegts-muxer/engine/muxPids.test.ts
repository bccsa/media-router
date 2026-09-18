import { describe, expect, it } from 'vitest';
import {
    audioStreamPid,
    videoStreamPid,
    TS_AUDIO_PID_BASE,
    TS_VIDEO_PID_BASE,
} from '@media-router/engine';
import {
    isReservedPid,
    muxRouteMedia,
    muxSlotPid,
    nextFreeInputPid,
    MAX_ES_PID,
    MUX_INPUT_PID_FIRST,
    MUX_INPUT_PID_STEP,
    MUX_ROUTE_PRIORITY,
    MUX_SLOTS_PER_CLASS,
    TS_DATA_PID_BASE,
    TS_KLV_PID_BASE,
    TS_METADATA_PID,
    TS_SUBTITLE_PID_BASE,
} from './muxPids.js';

describe('muxer PID scheme', () => {
    it('keeps every legacy class range clear of the next one and of the metadata PID', () => {
        const bases = [
            TS_VIDEO_PID_BASE,
            TS_AUDIO_PID_BASE,
            TS_KLV_PID_BASE,
            TS_SUBTITLE_PID_BASE,
            TS_DATA_PID_BASE,
        ];
        for (let i = 0; i < bases.length - 1; i++) {
            expect(bases[i] + MUX_SLOTS_PER_CLASS).toBeLessThanOrEqual(bases[i + 1]);
        }
        expect(TS_DATA_PID_BASE + MUX_SLOTS_PER_CLASS).toBeLessThanOrEqual(TS_METADATA_PID);
    });
    it('legacy video/audio slots coincide with the D3 scheme for the same index', () => {
        expect(muxSlotPid('video', 0)).toBe(videoStreamPid(0));
        expect(muxSlotPid('audio', 3)).toBe(audioStreamPid(3));
    });
    it('shares the KLV base with subtitle-core (0x180) so a VTT cue stream keeps its range', () => {
        expect(muxSlotPid('klv', 0)).toBe(0x180);
        expect(muxSlotPid('subtitle', 1)).toBe(0x1a1);
    });
    it('refuses a legacy slot outside the class range', () => {
        expect(() => muxSlotPid('video', MUX_SLOTS_PER_CLASS)).toThrow(RangeError);
        expect(() => muxSlotPid('video', -1)).toThrow(RangeError);
    });

    describe('one PID per generic input (next free automatic)', () => {
        it('starts at 0x100 and steps by 8, skipping whatever is taken', () => {
            expect(MUX_INPUT_PID_FIRST).toBe(0x100);
            expect(MUX_INPUT_PID_STEP).toBe(8);
            expect(nextFreeInputPid([])).toBe(0x100);
            expect(nextFreeInputPid([0x100])).toBe(0x108);
            expect(nextFreeInputPid([0x100, 0x108, 0x118])).toBe(0x110);
            // An operator value on an automatic slot is simply skipped.
            expect(nextFreeInputPid([0x100, 0x108])).toBe(0x110);
            // A value off the 8-grid does not block the grid.
            expect(nextFreeInputPid([0x101])).toBe(0x100);
        });
        it('never hands out a reserved PID (PMT 0x1000, carousel 0x1f0 — both on the 8-grid)', () => {
            expect(isReservedPid(0x1000)).toBe(true);
            expect(isReservedPid(TS_METADATA_PID)).toBe(true);
            expect(isReservedPid(0x100)).toBe(false);
            const upTo1f0 = Array.from({ length: 30 }, (_, k) => 0x100 + 8 * k); // 0x100..0x1e8
            expect(nextFreeInputPid(upTo1f0)).toBe(0x1f8);
        });
        it('throws only when the whole ES range is exhausted', () => {
            const all: number[] = [];
            for (let p = MUX_INPUT_PID_FIRST; p <= MAX_ES_PID; p += MUX_INPUT_PID_STEP) all.push(p);
            expect(() => nextFreeInputPid(all)).toThrow(RangeError);
        });
    });

    it('routes classes in the priority the hook uses when one input carries several streams', () => {
        expect(MUX_ROUTE_PRIORITY).toEqual(['video', 'audio', 'klv', 'subtitle']);
    });

    // Same table as py/mux_routing_test.py — the hook's classifier and this
    // one must agree, or the module joins discovery to the wrong slot.
    it('classifies tsdemux pad caps the way the runner hook does', () => {
        const table: Array<[string, ReturnType<typeof muxRouteMedia>]> = [
            ['video/x-h264, stream-format=(string)byte-stream', 'video'],
            ['video/x-h265', 'video'],
            ['audio/mpeg, mpegversion=(int)4', 'audio'],
            ['audio/x-opus', 'audio'],
            ['meta/x-klv, parsed=(boolean)true', 'klv'],
            ['meta/x-klv', 'klv'],
            ['application/x-teletext', 'subtitle'],
            ['subpicture/x-dvb', 'subtitle'],
            ['meta/x-id3', 'data'],
            ['private/x-unmapped', 'data'],
            ['', 'data'],
        ];
        for (const [caps, media] of table) expect(muxRouteMedia(caps)).toBe(media);
    });
});

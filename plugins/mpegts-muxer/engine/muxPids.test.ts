import { describe, expect, it } from 'vitest';
import {
    audioStreamPid,
    videoStreamPid,
    TS_AUDIO_PID_BASE,
    TS_VIDEO_PID_BASE,
} from '@media-router/engine';
import {
    muxInputBasePid,
    muxInputClassPid,
    muxRouteMedia,
    muxSlotPid,
    MUX_INPUT_PID_STRIDE,
    MUX_SLOTS_PER_CLASS,
    TS_DATA_PID_BASE,
    TS_KLV_PID_BASE,
    TS_METADATA_PID,
    TS_SUBTITLE_PID_BASE,
} from './muxPids.js';

describe('muxer PID scheme (route class × input)', () => {
    it('keeps every class range clear of the next one and of the metadata PID', () => {
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
    it('video/audio slots coincide with the D3 scheme for the same index', () => {
        expect(muxSlotPid('video', 0)).toBe(videoStreamPid(0));
        expect(muxSlotPid('audio', 3)).toBe(audioStreamPid(3));
    });
    it('shares the KLV base with subtitle-core (0x180) so a VTT cue stream keeps its range', () => {
        expect(muxSlotPid('klv', 0)).toBe(0x180);
        expect(muxSlotPid('subtitle', 1)).toBe(0x1a1);
    });
    it('lays generic inputs out in 8-PID blocks from 0x100, clear of the KLV range and the carousel', () => {
        expect(muxInputBasePid(0)).toBe(0x100);
        expect(muxInputBasePid(1)).toBe(0x108);
        expect(muxInputClassPid(muxInputBasePid(0), 'video')).toBe(0x100);
        expect(muxInputClassPid(muxInputBasePid(0), 'audio')).toBe(0x101);
        expect(muxInputClassPid(muxInputBasePid(0), 'klv')).toBe(0x102);
        expect(muxInputClassPid(muxInputBasePid(0), 'subtitle')).toBe(0x103);
        const last = muxInputBasePid(MUX_SLOTS_PER_CLASS - 1) + MUX_INPUT_PID_STRIDE - 1;
        expect(last).toBeLessThan(TS_KLV_PID_BASE);
        expect(last).toBeLessThan(TS_METADATA_PID);
        expect(() => muxInputBasePid(MUX_SLOTS_PER_CLASS)).toThrow(RangeError);
    });
    it('refuses a slot outside the class range', () => {
        expect(() => muxSlotPid('video', MUX_SLOTS_PER_CLASS)).toThrow(RangeError);
        expect(() => muxSlotPid('video', -1)).toThrow(RangeError);
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

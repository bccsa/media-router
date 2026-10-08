import { describe, expect, it } from 'vitest';
import {
    SUBTITLE_KLV_KEY,
    TS_SUBTITLE_PID_BASE,
    decodeSubtitleKlv,
} from '@media-router/plugin-subtitle-core/cue';
import {
    KLVA_REGISTRATION,
    KLV_RESEND_MS,
    encodeKlvCue,
    klvSubtitleCarrier,
    pangoEscape,
} from './klvSubtitleCarrier.js';

const S = 90_000;
const cue = (startSec: number, endSec: number, text: string) => ({
    startTicks: startSec * S,
    endTicks: endSec * S,
    text,
    payload: new Uint8Array(0),
});

describe('klvSubtitleCarrier', () => {
    it('announces the PID exactly as mpegtsmux does for meta/x-klv (0x06 + KLVA), from 0x180', () => {
        const c = klvSubtitleCarrier();
        expect(c.streamType).toBe(0x06);
        expect(Buffer.from(c.descriptors[0]).toString('hex')).toBe('05044b4c5641');
        expect(c.pidBase).toBe(TS_SUBTITLE_PID_BASE);
        expect(c.pidBase).toBe(0x180);
        expect(c.resendTicks).toBe(KLV_RESEND_MS * 90);
        expect(c.resendTicks).toBe(180_000);
        expect(c.encode).toBe(encodeKlvCue);
        expect(KLVA_REGISTRATION.length).toBe(6);
    });

    it('encodes a cue written at its start as a KLV triplet spanning 0 → duration', () => {
        const bytes = encodeKlvCue(cue(10, 13.5, 'Hei\nverden'), 10 * S);
        expect(Buffer.from(bytes.subarray(0, 16))).toEqual(Buffer.from(SUBTITLE_KLV_KEY));
        expect(decodeSubtitleKlv(bytes)).toEqual({ startMs: 0, endMs: 3500, text: 'Hei\nverden' });
    });

    it('a re-send carries the remaining span relative to its own PES', () => {
        expect(decodeSubtitleKlv(encodeKlvCue(cue(10, 13.5, 'x'), 12 * S))).toEqual({
            startMs: 0,
            endMs: 1500,
            text: 'x',
        });
    });

    it('a cue ahead of the PES keeps a positive relative start', () => {
        expect(decodeSubtitleKlv(encodeKlvCue(cue(10, 12, 'x'), 9 * S))).toEqual({
            startMs: 1000,
            endMs: 3000,
            text: 'x',
        });
    });

    it('escapes the text for the Pango-markup renderer', () => {
        expect(pangoEscape('A & B <3 >')).toBe('A &amp; B &lt;3 &gt;');
        expect(decodeSubtitleKlv(encodeKlvCue(cue(0, 1, 'a<b'), 0))?.text).toBe('a&lt;b');
    });

    it('rides hls-pipe end to end: PMT 0x06 + lang + KLVA on 0x180, PES payload decodes', async () => {
        const { MpegTsMuxer } = await import('hls-pipe');
        const carrier = klvSubtitleCarrier();
        const ts = new MpegTsMuxer({ subtitleCarrier: carrier }).muxMulti({
            video: [{ data: new Uint8Array([0, 0, 0, 1, 0x65]), pts: 0, dts: 0, isKeyframe: true }],
            audios: [],
            subtitles: [
                {
                    pid: carrier.pidBase,
                    language: 'nor',
                    samples: [{ pts: S, data: carrier.encode(cue(1, 3, 'hei'), S) }],
                },
            ],
        });
        const pkts: Uint8Array[] = [];
        for (let i = 0; i < ts.length; i += 188) pkts.push(ts.subarray(i, i + 188));
        const pid = (p: Uint8Array) => ((p[1] & 0x1f) << 8) | p[2];
        const payload = (p: Uint8Array) => p.subarray(p[3] & 0x20 ? 5 + p[4] : 4);
        // PMT (PID 0x1000): find the ES entry for 0x180.
        const pmt = payload(pkts.find((p) => pid(p) === 0x1000)!);
        const sec = pmt.subarray(1 + pmt[0]);
        const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
        const pil = ((sec[10] & 0x0f) << 8) | sec[11];
        let cur = 12 + pil;
        const entries: Array<{ type: number; pid: number; esInfo: string }> = [];
        while (cur < 3 + secLen - 4) {
            const el = ((sec[cur + 3] & 0x0f) << 8) | sec[cur + 4];
            entries.push({
                type: sec[cur],
                pid: ((sec[cur + 1] & 0x1f) << 8) | sec[cur + 2],
                esInfo: Buffer.from(sec.subarray(cur + 5, cur + 5 + el)).toString('hex'),
            });
            cur += 5 + el;
        }
        expect(entries).toContainEqual({ type: 0x06, pid: 0x180, esInfo: '0a046e6f7200' + '05044b4c5641' });
        // PES on 0x180: stream_id 0xBD, PTS-only header, KLV payload intact.
        const pes = payload(pkts.find((p) => pid(p) === 0x180 && p[1] & 0x40)!);
        expect(pes[3]).toBe(0xbd);
        expect(pes[7]).toBe(0x80);
        const klv = pes.subarray(9 + pes[8]);
        expect(decodeSubtitleKlv(klv)).toEqual({ startMs: 0, endMs: 2000, text: 'hei' });
    });
});

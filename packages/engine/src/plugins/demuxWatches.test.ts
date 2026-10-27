import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LatenessReporter } from './latenessReporter.js';
import {
    DemuxWatches,
    demuxWarningText,
    parseDemuxPayload,
    streamKind,
    type DemuxWarning,
} from './demuxWatches.js';

// The `mrtsdemux` structure as gstmrtsdemux.cpp posts it (demux_message plus each reason's fields).
const base = { select: '', program: 1, pid: -1, stream: 'found' };
const interval = (pes: number, o: Record<string, unknown> = {}) => ({
    ...base,
    reason: 'interval',
    pes,
    gaps: 0,
    'cc-lost': 0,
    markers: 0,
    'markers-dropped': 0,
    'pes-dropped-cc': 0,
    'pes-no-pts': 0,
    'desync-bytes': 0,
    'unknown-streams': 0,
    'frame-ns': 40_000_000,
    generation: 0,
    pads: 'video_0_0100',
    ...o,
});
const program = (generation: number, pads = `video_${generation}_0100`) => ({
    ...base,
    reason: 'program',
    generation,
    'pcr-pid': 256,
    pads,
});
const unknown = (pid: number, generation: number, streamType = 0x06, registration = '') => ({
    ...base,
    reason: 'unknown-stream',
    pid,
    'stream-type': streamType,
    registration,
    generation,
});
const offHouse = (pid: number, offsetMs: number) => ({
    ...base,
    reason: 'not-house-time',
    pid,
    'offset-ms': offsetMs,
});
const noStream = (select = '') => ({ ...base, select, stream: 'missing', reason: 'no-stream' });

const kinds = (d: DemuxWatches): string[] => d.list().flatMap((w) => w.warnings.map((x) => x.kind));

describe('parseDemuxPayload', () => {
    it('reads each field, and a generation only where the message carries one', () => {
        expect(parseDemuxPayload({})).toBeNull();
        expect(parseDemuxPayload({ reason: '' })).toBeNull();
        const i = parseDemuxPayload(interval(42, { gaps: 2, 'cc-lost': 7, generation: 3 }))!;
        expect(i).toMatchObject({ reason: 'interval', pes: 42, gaps: 2, ccLost: 7, generation: 3 });
        expect(parseDemuxPayload(offHouse(256, -7_200_000))).toMatchObject({
            pid: 256,
            offsetMs: -7_200_000,
            stream: 'found',
        });
        expect(parseDemuxPayload(offHouse(256, 1))!.generation).toBeUndefined();
        expect(parseDemuxPayload({ reason: 'x', stream: 'bogus' })!.stream).toBe('waiting');
    });
});

describe('DemuxWatches: the Demux row', () => {
    it('PES/s from the pes deltas over the last 10 s; gaps and CC lost as the demux counts them', () => {
        const d = new DemuxWatches();
        d.take('dm', interval(0), 0);
        expect(d.list()[0].counters).toBeUndefined(); // one report: no rate yet
        for (let s = 1; s <= 20; s++)
            d.take('dm', interval(s * 25, { gaps: 1, 'cc-lost': 3 }), s * 1000);
        expect(d.list()[0].counters).toEqual({
            pesPerS: 25,
            gaps: 1,
            ccLost: 3,
            unknownStreams: 0,
        });
        // A rise counts once the window has moved on to it.
        for (let s = 21; s <= 31; s++) d.take('dm', interval(500 + (s - 20) * 50), s * 1000);
        expect(d.list()[0].counters!.pesPerS).toBe(50);
    });

    it('a respawned element (counters back down) starts its rate again', () => {
        const d = new DemuxWatches();
        d.take('dm', interval(1000), 0);
        d.take('dm', interval(1025), 1000);
        d.take('dm', interval(10), 2000);
        expect(d.list()[0].counters).toBeUndefined();
        d.take('dm', interval(35), 3000);
        expect(d.list()[0].counters!.pesPerS).toBe(25);
    });

    it('expires a demux that stopped reporting', () => {
        const d = new DemuxWatches();
        d.take('dm', interval(0), 0);
        d.expire(6000, 6000);
        expect(d.list()).toHaveLength(1);
        d.expire(6001, 6000);
        expect(d.list()).toEqual([]);
    });
});

describe('DemuxWatches: the warnings', () => {
    it('unknown-stream: raised per PID, cleared at the next generation unless posted again', () => {
        const d = new DemuxWatches();
        d.take('dm', program(0), 0);
        expect(d.take('dm', unknown(0x101, 0), 0)!.changed).toBe(true);
        expect(d.take('dm', unknown(0x102, 0, 0x82), 0)!.changed).toBe(true);
        expect(d.list()[0].warnings).toEqual([
            { kind: 'demux-unknown-stream', pid: 0x101, streamType: 6, registration: '' },
            { kind: 'demux-unknown-stream', pid: 0x102, streamType: 0x82, registration: '' },
        ]);
        // A re-plan: the new generation's unknown streams come before its program message.
        expect(d.take('dm', unknown(0x101, 1), 10)!.changed).toBe(true);
        d.take('dm', program(1), 10);
        expect(d.list()[0].warnings.map((w) => (w as { pid: number }).pid)).toEqual([0x101]);
        d.take('dm', interval(10, { generation: 1, 'unknown-streams': 3 }), 11);
        d.take('dm', interval(20, { generation: 1, 'unknown-streams': 3 }), 12);
        expect(d.list()[0].counters!.unknownStreams).toBe(1); // the current program's
        d.take('dm', program(2), 20);
        expect(kinds(d)).toEqual([]);
    });

    it('not-house-time: raised once per pad, kept on its program, cleared at the next', () => {
        const d = new DemuxWatches();
        d.take('dm', program(0), 0);
        d.take('dm', offHouse(0x100, -7_200_000), 1);
        d.take('dm', offHouse(0x101, 61_000), 1);
        d.take('dm', interval(10), 2);
        expect(d.list()[0].warnings).toEqual([
            { kind: 'input-not-house-time', pid: 0x100, offsetMs: -7_200_000 },
        ]);
        expect(d.take('dm', program(1), 3)!.changed).toBe(true);
        expect(kinds(d)).toEqual([]);
    });

    it('no-stream: cleared when a report finds the stream, and at the next generation', () => {
        const d = new DemuxWatches();
        d.take('m', noStream('audio/x-smpte-302m'), 0);
        expect(d.list()[0].warnings).toEqual([
            { kind: 'input-no-stream', select: 'audio/x-smpte-302m' },
        ]);
        expect(d.take('m', interval(5, { stream: 'missing', generation: -1 }), 1)!.changed).toBe(
            false,
        );
        expect(d.take('m', interval(9, { stream: 'found', generation: -1 }), 2)!.changed).toBe(
            true,
        );
        expect(kinds(d)).toEqual([]);
        d.take('d', program(0, ''), 0);
        d.take('d', noStream(), 2);
        d.take('d', program(1), 3);
        expect(d.list().find((w) => w.name === 'd')!.warnings).toEqual([]);
    });

    it('a respawned element (its generation back down) keeps nothing of the old one', () => {
        const d = new DemuxWatches();
        d.take('dm', program(0), 0);
        d.take('dm', program(1), 1);
        d.take('dm', offHouse(0x100, 90_000), 2);
        expect(d.take('dm', program(0), 3)!.changed).toBe(true);
        expect(kinds(d)).toEqual([]);
    });

    it('a new program goes to the log once; the first is the start; select mode has none', () => {
        const d = new DemuxWatches();
        // Its reports start at the first buffer, before the PMT: generation -1, then the first.
        expect(d.take('dm', interval(0, { generation: -1 }), 0)!.program).toBeUndefined();
        expect(d.take('dm', program(0), 0)!.program).toBeUndefined();
        expect(d.take('dm', program(1, 'video_1_0100,audio_1_0101'), 1)!.program).toEqual({
            name: 'dm',
            generation: 1,
            pads: 'video_1_0100,audio_1_0101',
            pcrPid: 256,
        });
        expect(d.take('dm', program(1), 2)!.program).toBeUndefined();
        expect(d.take('dm', interval(5, { generation: 1 }), 3)!.program).toBeUndefined();
        const s = new DemuxWatches();
        for (let t = 0; t < 3; t++) {
            expect(s.take('sel', interval(t, { generation: -1, select: 'a' }), t)!.program).toBe(
                undefined,
            );
        }
    });
});

describe('the warning texts', () => {
    const t = (w: DemuxWarning, media?: string) => demuxWarningText(w, 'enc-1 (out)', media);
    it('name the input, the PID and the type; the offset in seconds; the media missing', () => {
        expect(
            t({ kind: 'demux-unknown-stream', pid: 0x123, streamType: 0x06, registration: '' }),
        ).toBe(
            'Input enc-1 (out): PID 0x0123: stream type 0x06 with no known descriptor is not demuxed',
        );
        expect(
            t({
                kind: 'demux-unknown-stream',
                pid: 0x1fff,
                streamType: 0x82,
                registration: 'DTS1',
            }),
        ).toBe(
            'Input enc-1 (out): PID 0x1fff: stream type 0x82 (registration DTS1) is not demuxed',
        );
        expect(t({ kind: 'input-not-house-time', pid: 0x100, offsetMs: -7_200_000 })).toBe(
            'Input enc-1 (out) is 7200 s off house time — its producer does not stamp house time',
        );
        expect(t({ kind: 'input-not-house-time', pid: 0x100, offsetMs: 61_500 })).toContain(
            'is 62 s off',
        );
        expect(t({ kind: 'input-no-stream', select: 'audio/x-smpte-302m' })).toBe(
            'Input enc-1 (out) carries no 302M audio stream',
        );
        expect(t({ kind: 'input-no-stream', select: '' }, 'audio')).toBe(
            'Input enc-1 (out) carries no audio stream',
        );
        expect(t({ kind: 'input-no-stream', select: '' })).toBe(
            'Input enc-1 (out) carries no stream',
        );
    });

    it('a stream kind in words', () => {
        expect(streamKind('audio/mpeg')).toBe('audio');
        expect(streamKind('video/x-h264')).toBe('video');
        expect(streamKind('meta/x-klv')).toBe('meta/x-klv');
        expect(streamKind('', 'video, audio')).toBe('video or audio');
        expect(streamKind('', 'private')).toBe('data');
        expect(streamKind('', 'subpicture')).toBe('subtitle');
        expect(streamKind('', 'video,audio,private,subpicture')).toBe('');
    });
});

describe('the forwarded messages as recorded (forwarded-messages.json)', () => {
    // The payloads both runners forward (native_runner_protocol_test.py holds them to this file).
    const fixture = JSON.parse(
        readFileSync(
            join(process.cwd(), 'plugins/mpegts-core/tests/fixtures/forwarded-messages.json'),
            'utf8',
        ),
    ).mrtsdemux as Record<string, Record<string, unknown>>;

    it("make the engine's row and warnings", () => {
        const r = new LatenessReporter({
            inputs: () => [{ tap: 'lat_busin_41000_aa11bb', n: 1, label: 'srt-1 (mpegts-in)' }],
        });
        r.onEvent('mrlateness:lat_busin_41000_aa11bb', { count: 10, 'mean-ns': 40e6 }, 0);
        const order = ['program', 'unknown-stream', 'not-house-time', 'interval'];
        for (const reason of order) r.onEvent(`mrtsdemux:demux`, fixture[reason], 0);
        const next = { ...fixture.interval, pes: (fixture.interval.pes as number) + 25 };
        r.onEvent('mrtsdemux:demux', next, 1000);
        expect(r.summary(1000).inputs[0].demux).toEqual({
            pesPerS: 25,
            gaps: 0,
            ccLost: 0,
            unknownStreams: 1,
        });
        expect(r.streamWarnings(1000).map((w) => w.text)).toEqual([
            'Input srt-1 (mpegts-in): PID 0x0101: stream type 0x82 is not demuxed',
            'Input srt-1 (mpegts-in) is 7200 s off house time — its producer does not stamp house time',
        ]);
        r.onEvent('mrtsdemux:demux', fixture['no-stream'], 1000);
        expect(r.streamWarnings(1000).map((w) => w.kind)).toContain('input-no-stream');
    });
});

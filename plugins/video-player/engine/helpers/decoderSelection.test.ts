import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CODEC_CAPS,
    CPU_DECODE_THREADING,
    DECODEBIN_ID,
    DECODEBIN_SELECTION,
    DECODER_ELEMENTS,
    DECODER_LADDERS,
    RANK_ENV_VAR,
    VIDEO_DECODER_NAME,
    decoderDemotionNote,
    decoderRankEnv,
    probeDecoderAvailability,
    resolveCpuDecodeThreading,
    selectDecoder,
    type CpuDecodeThreading,
    type DecoderAvailability,
    type DecoderRung,
} from './decoderSelection.js';

/** Everything installed — the Pi 5 / full-GStreamer case. */
const ALL: DecoderAvailability = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));

/** Nothing installed — a stripped image, or `initManifest` not run yet. */
const NONE: DecoderAvailability = {};

function only(...elements: string[]): DecoderAvailability {
    return Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, elements.includes(e)]));
}

describe('selectDecoder', () => {
    describe('bootstrap / unknown codec', () => {
        it('falls back to decodebin3 when no codec has been detected yet', () => {
            // The pipeline the player has always built: no videoinfo has
            // arrived, so we cannot know what to plug.
            const s = selectDecoder({ available: ALL });
            expect(s.id).toBe(DECODEBIN_ID);
            expect(s.chain).toBe('decodebin3');
            expect(s.caps).toBe('');
            expect(s.explicit).toBe(false);
            expect(s.hardware).toBe(false);
        });

        it('falls back to decodebin3 for a codec with no ladder (mpeg2, unknown, junk)', () => {
            for (const codec of ['mpeg2', 'mpeg1', 'unknown', 'vp9', '']) {
                expect(selectDecoder({ codec, available: ALL }).id).toBe(DECODEBIN_ID);
            }
        });
    });

    describe('h264 ladder', () => {
        it('prefers the V4L2 hardware decoder when it and h264parse are installed', () => {
            const s = selectDecoder({ codec: 'h264', available: ALL });
            expect(s.id).toBe('v4l2h264dec');
            expect(s.chain).toBe('h264parse ! v4l2h264dec name=vpdec');
            expect(s.caps).toBe('capsfilter caps="video/x-h264"');
            expect(s.hardware).toBe(true);
            expect(s.explicit).toBe(true);
        });

        it('falls to avdec_h264 when the hardware decoder is not installed', () => {
            const s = selectDecoder({ codec: 'h264', available: only('h264parse', 'avdec_h264') });
            expect(s.id).toBe('avdec_h264');
            // Threaded by default — see the cpuDecodeThreading block.
            expect(s.chain).toBe(
                'h264parse ! avdec_h264 name=vpdec thread-type=frame max-threads=3',
            );
            expect(s.hardware).toBe(false);
        });

        it('falls all the way to decodebin3 when no h264 decoder is installed', () => {
            expect(selectDecoder({ codec: 'h264', available: only('h264parse') }).id).toBe(
                DECODEBIN_ID,
            );
            expect(selectDecoder({ codec: 'h264', available: NONE }).id).toBe(DECODEBIN_ID);
        });

        it('skips a rung whose PARSER is missing even when the decoder is installed', () => {
            // A stripped image can ship the decoder without the parser; an
            // unparsed byte-stream into avdec is a broken pipeline, not a
            // slower one.
            const s = selectDecoder({
                codec: 'h264',
                available: only('v4l2h264dec', 'avdec_h264'),
            });
            expect(s.id).toBe(DECODEBIN_ID);
        });
    });

    describe('h265 ladder', () => {
        it('prefers the stateless V4L2 decoder (rpivid) when installed', () => {
            const s = selectDecoder({ codec: 'h265', available: ALL });
            expect(s.id).toBe('v4l2slh265dec');
            expect(s.chain).toBe('h265parse ! v4l2slh265dec name=vpdec');
            expect(s.caps).toBe('capsfilter caps="video/x-h265"');
            expect(s.hardware).toBe(true);
        });

        it('falls to avdec_h265, then decodebin3', () => {
            expect(
                selectDecoder({ codec: 'h265', available: only('h265parse', 'avdec_h265') }).id,
            ).toBe('avdec_h265');
            expect(selectDecoder({ codec: 'h265', available: only('h265parse') }).id).toBe(
                DECODEBIN_ID,
            );
        });

        it('keeps the two ladders independent (h264 hardware present, h265 not)', () => {
            const mixed = only('h264parse', 'v4l2h264dec', 'h265parse', 'avdec_h265');
            expect(selectDecoder({ codec: 'h264', available: mixed }).id).toBe('v4l2h264dec');
            expect(selectDecoder({ codec: 'h265', available: mixed }).id).toBe('avdec_h265');
        });
    });

    describe('cpuDecodeThreading', () => {
        it('threads the software rung on "auto" — both codecs', () => {
            // The field regression this default exists for: bare, the explicit
            // software rung decodes on ONE core and lagged a 1080p50 H.264 feed
            // on a Pi 5 that was 62% idle.
            expect(
                selectDecoder({
                    codec: 'h264',
                    available: only('h264parse', 'avdec_h264'),
                    threading: 'auto',
                }).chain,
            ).toBe('h264parse ! avdec_h264 name=vpdec thread-type=frame max-threads=3');
            expect(
                selectDecoder({
                    codec: 'h265',
                    available: only('h265parse', 'avdec_h265'),
                    threading: 'auto',
                }).chain,
            ).toBe('h265parse ! avdec_h265 name=vpdec thread-type=frame max-threads=3');
        });

        it('threads the software rung when no threading value is passed (same default)', () => {
            expect(
                selectDecoder({ codec: 'h265', available: only('h265parse', 'avdec_h265') }).chain,
            ).toBe('h265parse ! avdec_h265 name=vpdec thread-type=frame max-threads=3');
        });

        it('inlines frame threading on "frame" (same form the transcoder uses)', () => {
            // Must be set at element construction: the runner's hook leaves a
            // decoder whose max-threads is already pinned alone.
            expect(
                selectDecoder({
                    codec: 'h264',
                    available: only('h264parse', 'avdec_h264'),
                    threading: 'frame',
                }).chain,
            ).toBe('h264parse ! avdec_h264 name=vpdec thread-type=frame max-threads=3');
            expect(
                selectDecoder({
                    codec: 'h265',
                    available: only('h265parse', 'avdec_h265'),
                    threading: 'frame',
                }).chain,
            ).toBe('h265parse ! avdec_h265 name=vpdec thread-type=frame max-threads=3');
        });

        it('leaves the software rung bare on "single" — the one-core opt-out', () => {
            for (const [codec, chain] of [
                ['h264', 'h264parse ! avdec_h264 name=vpdec'],
                ['h265', 'h265parse ! avdec_h265 name=vpdec'],
            ]) {
                const s = selectDecoder({
                    codec,
                    available: only(`${codec}parse`, `avdec_${codec}`),
                    threading: 'single',
                });
                expect(s.chain).toBe(chain);
                expect(s.chain).not.toContain('thread-type');
            }
        });

        it('never puts ffmpeg threading on a hardware rung', () => {
            // thread-type/max-threads are ffmpeg properties; a V4L2 decoder has
            // neither, and naming one would fail the pipeline parse.
            for (const threading of ['auto', 'frame', 'single'] as CpuDecodeThreading[]) {
                expect(selectDecoder({ codec: 'h265', available: ALL, threading }).chain).toBe(
                    'h265parse ! v4l2slh265dec name=vpdec',
                );
                expect(selectDecoder({ codec: 'h264', available: ALL, threading }).chain).toBe(
                    'h264parse ! v4l2h264dec name=vpdec',
                );
            }
        });
    });

    describe('demotions', () => {
        it('skips a demoted hardware decoder and lands on software', () => {
            const s = selectDecoder({
                codec: 'h265',
                available: ALL,
                demoted: new Set(['v4l2slh265dec']),
            });
            expect(s.id).toBe('avdec_h265');
        });

        it('lands on decodebin3 once every explicit rung is demoted', () => {
            const s = selectDecoder({
                codec: 'h264',
                available: ALL,
                demoted: new Set(['v4l2h264dec', 'avdec_h264']),
            });
            expect(s.id).toBe(DECODEBIN_ID);
            expect(s.explicit).toBe(false);
        });

        it('demoting one codec’s decoder leaves the other codec untouched', () => {
            const demoted = new Set(['v4l2slh265dec']);
            expect(selectDecoder({ codec: 'h264', available: ALL, demoted }).id).toBe(
                'v4l2h264dec',
            );
            expect(selectDecoder({ codec: 'h265', available: ALL, demoted }).id).toBe('avdec_h265');
        });

        it('an empty demotion set changes nothing', () => {
            expect(selectDecoder({ codec: 'h264', available: ALL, demoted: new Set() }).id).toBe(
                'v4l2h264dec',
            );
        });
    });

    describe('caps mapping', () => {
        it('every ladder codec has a CODEC_CAPS entry', () => {
            // The capsfilter is spliced into the pipeline string by name; a
            // ladder added without its caps entry would emit
            // `caps="undefined"` and fail the parse at runtime instead of here.
            for (const codec of Object.keys(DECODER_LADDERS)) {
                expect(CODEC_CAPS[codec], `missing CODEC_CAPS for ${codec}`).toBeTruthy();
            }
        });

        it('never emits a capsfilter for a codec with no caps entry', () => {
            // Simulate the drift: a ladder key that CODEC_CAPS doesn't cover.
            const ladders = DECODER_LADDERS as Record<string, DecoderRung[]>;
            ladders.av1 = [{ id: 'av1dec', parser: 'av1parse', requires: [], hardware: false }];
            try {
                const s = selectDecoder({ codec: 'av1', available: ALL });
                expect(s).toEqual(DECODEBIN_SELECTION);
                expect(s.caps).not.toContain('undefined');
            } finally {
                delete ladders.av1;
            }
        });
    });

    describe('named decoder element (keyframe-gate anchor)', () => {
        // The runner finds the pad to gate by this ONE name, so it has to be
        // on every explicit rung and identical across them.
        it('names the decoder on every rung of every ladder, hardware and software', () => {
            for (const codec of Object.keys(DECODER_LADDERS)) {
                for (const threading of CPU_DECODE_THREADING) {
                    for (const demoted of [
                        new Set<string>(),
                        new Set([DECODER_LADDERS[codec][0].id]),
                    ]) {
                        const s = selectDecoder({ codec, available: ALL, threading, demoted });
                        expect(s.explicit, `${codec}/${threading}`).toBe(true);
                        expect(s.chain).toContain(`${s.id} name=${VIDEO_DECODER_NAME}`);
                    }
                }
            }
        });

        it('puts the name directly on the decoder, never on the parser', () => {
            const s = selectDecoder({ codec: 'h265', available: ALL });
            expect(s.chain).toBe(`h265parse ! v4l2slh265dec name=${VIDEO_DECODER_NAME}`);
            expect(s.chain.indexOf('name=')).toBeGreaterThan(s.chain.indexOf('v4l2slh265dec'));
        });

        it('names nothing on the decodebin3 rung — the bin plugs its own decoder', () => {
            expect(DECODEBIN_SELECTION.chain).not.toContain('name=');
            expect(selectDecoder({ codec: 'mpeg2', available: ALL }).chain).not.toContain('name=');
        });

        it('keeps the ffmpeg threading props after the name (parse order is not fussy, drift is)', () => {
            expect(
                selectDecoder({ codec: 'h264', available: only('h264parse', 'avdec_h264') }).chain,
            ).toBe(
                `h264parse ! avdec_h264 name=${VIDEO_DECODER_NAME} thread-type=frame max-threads=3`,
            );
        });
    });
});

describe('resolveCpuDecodeThreading', () => {
    it('accepts every value in the contract unchanged', () => {
        for (const value of CPU_DECODE_THREADING) {
            expect(resolveCpuDecodeThreading(value)).toBe(value);
        }
    });

    it('falls back to the "auto" default for anything unrecognised', () => {
        // Junk must never reach the pipeline string: an unknown value resolves
        // to the manifest default rather than to the bare (one-core) element.
        for (const junk of [undefined, null, '', 'slice', 'multi', 1, {}]) {
            expect(resolveCpuDecodeThreading(junk)).toBe('auto');
        }
    });
});

describe('cpuDecodeThreading manifest ↔ code contract', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'))
        .mediaRouter.configSchema.properties.cpuDecodeThreading;

    it('offers exactly the two operator choices, defaulting to the threaded one', () => {
        expect(schema.enum).toEqual(['auto', 'single']);
        expect(schema.default).toBe('auto');
        expect(Object.keys(schema['x-enumLabels'])).toEqual(schema.enum);
    });

    it('offers nothing the code would reject', () => {
        for (const value of schema.enum) {
            expect(CPU_DECODE_THREADING).toContain(value);
            expect(resolveCpuDecodeThreading(value)).toBe(value);
        }
        expect(resolveCpuDecodeThreading(schema.default)).toBe(schema.default);
    });

    it('still accepts the legacy "frame" spelling the manifest no longer offers', () => {
        // Profiles saved when multi-core was the opt-in carry `'frame'`. It is
        // accepted (and means multi-core) rather than reset, so upgrading a box
        // can't quietly change how it decodes.
        expect(schema.enum).not.toContain('frame');
        expect(CPU_DECODE_THREADING).toContain('frame');
        expect(
            selectDecoder({
                codec: 'h264',
                available: only('h264parse', 'avdec_h264'),
                threading: 'frame',
            }).chain,
        ).toBe(selectDecoder({ codec: 'h264', available: only('h264parse', 'avdec_h264') }).chain);
    });
});

describe('decoderRankEnv', () => {
    const decodebin = DECODEBIN_SELECTION;
    const explicit = selectDecoder({ codec: 'h265', available: ALL });

    it('sets NOTHING with no demotions — decodebin3 auto-plugs by rank, hardware included', () => {
        // The bootstrap rung and the last-rung fallback both get the box's own
        // best decoder. Masking hardware here unconditionally was tried and
        // dropped: it charged every player software decode forever to guard a
        // failure the demotion path already handles.
        expect(decoderRankEnv(decodebin, new Set())).toEqual({});
        expect(decoderRankEnv(decodebin, undefined)).toEqual({});
    });

    it('masks exactly the demoted decoders, and only them', () => {
        // The last-rung escape: decodebin3 auto-plugs BY RANK and would re-plug
        // the decoder we struck off, whose error is `ignore`d on this rung —
        // fail → restart → replug, forever.
        expect(decoderRankEnv(decodebin, new Set(['avdec_h265']))).toEqual({
            [RANK_ENV_VAR]: 'avdec_h265:NONE',
        });
        expect(decoderRankEnv(decodebin, new Set(['v4l2slh265dec']))).toEqual({
            [RANK_ENV_VAR]: 'v4l2slh265dec:NONE',
        });
    });

    it('lists several demotions in failure order, comma-joined', () => {
        expect(decoderRankEnv(decodebin, new Set(['v4l2slh265dec', 'avdec_h265']))).toEqual({
            GST_PLUGIN_FEATURE_RANK: 'v4l2slh265dec:NONE,avdec_h265:NONE',
        });
    });

    it('names a hardware decoder only when it was actually demoted', () => {
        // No blanket policy list any more — the ladder's hardware rungs are
        // masked here if and only if they failed at runtime.
        const hardware = Object.values(DECODER_LADDERS)
            .flat()
            .filter((rung) => rung.hardware)
            .map((rung) => rung.id);
        expect(hardware).toEqual(['v4l2h264dec', 'v4l2slh265dec']);
        const env = decoderRankEnv(decodebin, new Set(['v4l2h264dec']));
        expect(env[RANK_ENV_VAR]).toContain('v4l2h264dec:NONE');
        expect(env[RANK_ENV_VAR]).not.toContain('v4l2slh265dec');
    });

    it('sets nothing on an explicit rung — the decoder is named outright', () => {
        // Masking there would strike out the very hardware decoder the
        // explicit (and keyframe-gated) rungs exist to use.
        expect(decoderRankEnv(explicit, new Set(['v4l2h264dec']))).toEqual({});
        expect(decoderRankEnv(explicit, undefined)).toEqual({});
    });
});

describe('decoderDemotionNote', () => {
    it('returns undefined when nothing was demoted for this codec', () => {
        const s = selectDecoder({ codec: 'h264', available: ALL });
        expect(decoderDemotionNote('h264', s, new Set())).toBeUndefined();
        // A demotion on the OTHER codec's ladder must not raise a note here.
        expect(decoderDemotionNote('h264', s, new Set(['v4l2slh265dec']))).toBeUndefined();
    });

    it('returns undefined without a codec (bootstrap / no ladder)', () => {
        const s = selectDecoder({ available: ALL });
        expect(decoderDemotionNote(undefined, s, new Set(['v4l2h264dec']))).toBeUndefined();
        expect(decoderDemotionNote('mpeg2', s, new Set(['v4l2h264dec']))).toBeUndefined();
    });

    it('names the lost hardware decoder and the software rung now in use', () => {
        const demoted = new Set(['v4l2slh265dec']);
        const s = selectDecoder({ codec: 'h265', available: ALL, demoted });
        expect(decoderDemotionNote('h265', s, demoted)).toBe(
            'Hardware decoder v4l2slh265dec failed — using software decode (avdec_h265)',
        );
    });

    it('names the BEST rung lost once the whole ladder is demoted', () => {
        // What the operator lost is hardware decode; the per-failure detail
        // lives in the log, not in the health note.
        const demoted = new Set(['v4l2h264dec', 'avdec_h264']);
        const s = selectDecoder({ codec: 'h264', available: ALL, demoted });
        expect(decoderDemotionNote('h264', s, demoted)).toBe(
            'Hardware decoder v4l2h264dec failed — using automatic decoder selection',
        );
    });

    it('reports a software-only demotion as such', () => {
        // Host without the V4L2 decoder: the only rung above decodebin3 is avdec.
        const available = only('h264parse', 'avdec_h264');
        const demoted = new Set(['avdec_h264']);
        const s = selectDecoder({ codec: 'h264', available, demoted });
        expect(decoderDemotionNote('h264', s, demoted)).toBe(
            'Software decoder avdec_h264 failed — using automatic decoder selection',
        );
    });
});

describe('probeDecoderAvailability', () => {
    it('probes every ladder element exactly once and maps the verdicts', async () => {
        const probe = vi.fn(async (el: string) => el.startsWith('h26') || el === 'avdec_h264');
        const availability = await probeDecoderAvailability(probe);
        expect(probe).toHaveBeenCalledTimes(DECODER_ELEMENTS.length);
        for (const el of DECODER_ELEMENTS) expect(probe).toHaveBeenCalledWith(el);
        expect(availability).toEqual({
            h264parse: true,
            v4l2h264dec: false,
            avdec_h264: true,
            h265parse: true,
            v4l2slh265dec: false,
            avdec_h265: false,
        });
    });

    it('feeds selectDecoder — a host with only software decode picks avdec', async () => {
        const availability = await probeDecoderAvailability(
            async (el) => el === 'h264parse' || el === 'avdec_h264',
        );
        expect(selectDecoder({ codec: 'h264', available: availability }).id).toBe('avdec_h264');
        expect(selectDecoder({ codec: 'h265', available: availability }).id).toBe(DECODEBIN_ID);
    });
});

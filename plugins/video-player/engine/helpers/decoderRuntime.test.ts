import { describe, it, expect, vi } from 'vitest';
import {
    SYNTHESISED_ERROR_KINDS,
    classifyDecoderFailure,
    planCodecReport,
    type DecoderFailureInput,
} from './decoderRuntime.js';
import {
    DECODEBIN_SELECTION,
    VIDEO_DECODER_NAME,
    type DecoderSelection,
} from './decoderSelection.js';

const rung = (id: string): DecoderSelection => ({
    id,
    chain: `${id}parse ! ${id}`,
    caps: 'capsfilter caps="video/x-test"',
    hardware: id.startsWith('v4l2'),
    explicit: true,
});

describe('planCodecReport', () => {
    it('ignores a report while the fallback card is up (no live decoder recorded)', () => {
        expect(
            planCodecReport({
                codec: 'h264',
                liveDecoder: undefined,
                liveDecoderCodec: undefined,
                selectRung: () => rung('v4l2h264dec'),
            }),
        ).toEqual({ kind: 'ignore' });
    });

    it('ignores a repeat of the codec the running pipeline was built for', () => {
        const selectRung = vi.fn(() => rung('v4l2h264dec'));
        expect(
            planCodecReport({
                codec: 'h264',
                liveDecoder: rung('v4l2h264dec'),
                liveDecoderCodec: 'h264',
                selectRung,
            }),
        ).toEqual({ kind: 'ignore' });
        // Debounced before the ladder is even consulted.
        expect(selectRung).not.toHaveBeenCalled();
    });

    it('records the codec without a rebuild when it resolves to the SAME rung', () => {
        // An mpeg2 report while already on decodebin3 changes nothing —
        // tearing the picture down for it is pure loss.
        expect(
            planCodecReport({
                codec: 'mpeg2',
                liveDecoder: DECODEBIN_SELECTION,
                liveDecoderCodec: undefined,
                selectRung: () => DECODEBIN_SELECTION,
            }),
        ).toEqual({ kind: 'record-codec' });
    });

    it('rebuilds when the new codec resolves to a different rung', () => {
        const next = rung('v4l2h264dec');
        expect(
            planCodecReport({
                codec: 'h264',
                liveDecoder: rung('v4l2slh265dec'),
                liveDecoderCodec: 'h265',
                selectRung: () => next,
            }),
        ).toEqual({ kind: 'rebuild', next });
    });

    it('rebuilds the bootstrap decodebin3 pipeline once the codec is known', () => {
        const next = rung('v4l2slh265dec');
        const action = planCodecReport({
            codec: 'h265',
            liveDecoder: DECODEBIN_SELECTION,
            liveDecoderCodec: undefined,
            selectRung: () => next,
        });
        expect(action).toEqual({ kind: 'rebuild', next });
    });
});

describe('classifyDecoderFailure', () => {
    const live = rung('v4l2slh265dec');
    const base: DecoderFailureInput = {
        liveDecoder: live,
        restartInProgress: false,
        detectedCodec: 'h265',
        liveDecoderCodec: 'h265',
        // Real errors carry the gst bus message's source element instance —
        // gst auto-names the unnamed decoder `<factory>0`.
        element: 'v4l2slh265dec0',
    };

    it('demotes the explicit decoder when the error came from the decoder itself', () => {
        expect(classifyDecoderFailure(base)).toEqual({ kind: 'demote', failed: live });
    });

    it('ignores a source-side timeout — not a decode failure', () => {
        expect(classifyDecoderFailure({ ...base, errorKind: 'udp_timeout' })).toEqual({
            kind: 'ignore',
        });
    });

    it('ignores errors on the decodebin3 rung — nothing below it to demote to', () => {
        expect(classifyDecoderFailure({ ...base, liveDecoder: DECODEBIN_SELECTION })).toEqual({
            kind: 'ignore',
        });
    });

    it('ignores errors from the fallback card (no decoder recorded)', () => {
        expect(classifyDecoderFailure({ ...base, liveDecoder: undefined })).toEqual({
            kind: 'ignore',
        });
    });

    it('ignores errors thrown by a pipeline an internal restart is tearing down', () => {
        expect(classifyDecoderFailure({ ...base, restartInProgress: true })).toEqual({
            kind: 'ignore',
        });
    });

    it('rebuilds without demoting when the codec changed after the build', () => {
        // The chain failed because it was steering the WRONG codec's caps.
        // Checked BEFORE attribution: even a decoder-sourced error here is the
        // wrong caps talking, not a broken decoder.
        expect(classifyDecoderFailure({ ...base, detectedCodec: 'h264' })).toEqual({
            kind: 'codec-changed',
        });
    });

    describe('attribution — only the decoder’s own failures cost it its rung', () => {
        it('demotes on any instance of the decoder factory (auto-name suffix varies)', () => {
            for (const element of ['v4l2slh265dec0', 'v4l2slh265dec', 'v4l2slh265dec12']) {
                expect(classifyDecoderFailure({ ...base, element })).toEqual({
                    kind: 'demote',
                    failed: live,
                });
            }
        });

        it('demotes on the STABLE `vpdec` name the explicit chain gives the decoder', () => {
            // The explicit chain names its decoder (`v4l2slh265dec name=vpdec`)
            // so the runner's keyframe gate can find the pad — which means the
            // bus reports `vpdec`, not `v4l2slh265dec0`, as the error source.
            // Without this rule every real decoder failure would look like
            // somebody else's and the whole demotion ladder would go dark.
            expect(classifyDecoderFailure({ ...base, element: VIDEO_DECODER_NAME })).toEqual({
                kind: 'demote',
                failed: live,
            });
            // Same for the software rung — the name does not vary by rung.
            expect(
                classifyDecoderFailure({
                    ...base,
                    liveDecoder: rung('avdec_h265'),
                    element: VIDEO_DECODER_NAME,
                }),
            ).toEqual({ kind: 'demote', failed: rung('avdec_h265') });
        });

        it('keeps the decoder when the SINK failed — the field regression', () => {
            // Pi 4 10.9.1.165: a compositor/cog flap took waylandsink down
            // mid-session and the healthy hardware decoder was demoted for the
            // rest of the engine session. Same decoder choice comes back on the
            // runner's replay.
            expect(classifyDecoderFailure({ ...base, element: 'waylandsink0' })).toEqual({
                kind: 'rebuild-same',
                element: 'waylandsink0',
            });
        });

        it('keeps the decoder when the PARSER (or anything else) failed', () => {
            for (const element of [
                'h265parse0',
                'h264parse0',
                'tsdemux0',
                'tsparse0',
                'unixfdsrc0',
                'queue3',
                'vp_ts',
                'appsink0',
                'videoconvert0',
                'mystery-element',
            ]) {
                expect(classifyDecoderFailure({ ...base, element })).toEqual({
                    kind: 'rebuild-same',
                    element,
                });
            }
        });

        it('demotes on the decoder element however many other failures preceded it', () => {
            // The rule is per-error and stateless: nothing about earlier
            // non-decoder errors can make this one anything but a demotion.
            expect(classifyDecoderFailure({ ...base, element: 'waylandsink0' })).toEqual({
                kind: 'rebuild-same',
                element: 'waylandsink0',
            });
            expect(classifyDecoderFailure({ ...base, element: 'v4l2slh265dec0' })).toEqual({
                kind: 'demote',
                failed: live,
            });
        });
    });

    describe('errors that name no element — rebuild, never demote', () => {
        const unattributed = { ...base, element: undefined };

        it('rebuilds without demoting, however many times it repeats', () => {
            // A count-based escape hatch was tried here and removed: an error
            // that doesn't name the decoder is not evidence about the decoder,
            // and repetition doesn't make it evidence. A compositor/cog flap
            // stranded a healthy hardware decoder on software decode for the
            // rest of the session (field, Pi 4 10.9.1.165, 2026-08-03).
            for (let i = 0; i < 5; i++) {
                expect(classifyDecoderFailure(unattributed)).toEqual({ kind: 'rebuild-same' });
            }
        });

        it('treats an empty element string as no attribution', () => {
            // Runner sends `""` when the bus message has no src name.
            expect(classifyDecoderFailure({ ...unattributed, element: '' })).toEqual({
                kind: 'rebuild-same',
            });
        });

        it('carries no streak state on the action at all', () => {
            const action = classifyDecoderFailure(unattributed);
            expect(Object.keys(action)).toEqual(['kind']);
        });
    });

    describe('runner-synthesised errors never demote', () => {
        const unattributed = { ...base, element: undefined };

        it('rebuilds on a preroll timeout', () => {
            // A wedged compositor never lets the pipeline reach PLAYING and the
            // watchdog fires every 10 s — it must never cost the decoder its
            // rung, no matter how long it goes on.
            expect(
                classifyDecoderFailure({ ...unattributed, errorKind: 'playing_timeout' }),
            ).toEqual({ kind: 'rebuild-same' });
        });

        it('covers every synthesised kind the runner layers emit', () => {
            for (const errorKind of SYNTHESISED_ERROR_KINDS) {
                expect(classifyDecoderFailure({ ...unattributed, errorKind })).toEqual({
                    kind: 'rebuild-same',
                });
            }
            expect([...SYNTHESISED_ERROR_KINDS]).toEqual([
                'playing_timeout',
                'spawn_failed',
                'runner_exit',
                'max_restarts',
            ]);
        });

        it('wins over attribution if one ever arrives carrying the decoder name', () => {
            // Defensive: the runner names no element on these today. If it ever
            // forwarded a last-seen one, a wedged compositor must still not be
            // able to demote a decoder that never posted an error itself.
            expect(
                classifyDecoderFailure({
                    ...base,
                    errorKind: 'max_restarts',
                    element: VIDEO_DECODER_NAME,
                }),
            ).toEqual({ kind: 'rebuild-same' });
        });

        it('still ignores a synthesised error on the decodebin3 rung / fallback card', () => {
            expect(
                classifyDecoderFailure({
                    ...unattributed,
                    errorKind: 'playing_timeout',
                    liveDecoder: DECODEBIN_SELECTION,
                }),
            ).toEqual({ kind: 'ignore' });
        });
    });
});

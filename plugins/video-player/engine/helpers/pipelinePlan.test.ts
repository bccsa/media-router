import * as fs from 'fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `resolveResumeSocket` gates the fallback's resume tap on the edge socket
// existing. Wrap just that export so the verdict is controllable; everything
// else in fs stays real.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import {
    planFallbackPipeline,
    planLivePipeline,
    planSink,
    resolveBuildHealth,
    resolveResumeSocket,
} from './pipelinePlan.js';
import { DEFAULT_SURFACE, RESUME_SINK_NAME } from './pipelines.js';
import {
    DECODEBIN_SELECTION,
    VIDEO_DECODER_NAME,
    type DecoderSelection,
} from './decoderSelection.js';
import type { RenderTargetReady } from './renderTarget.js';

const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

function readyTarget(over: Partial<RenderTargetReady> = {}): RenderTargetReady {
    return {
        kind: 'ready',
        active: { name: 'HDMI-A-1', connectorId: 32, substituted: false },
        sinkEnv: { wayland: false, kms: true, waylandSession: false, connectorId: 32 },
        renderConnector: 'HDMI-A-1',
        waylandFullscreen: false,
        env: {},
        ...over,
    };
}

describe('planSink', () => {
    it('defaults to a QoS-on, clock-paced KMS sink pinned to the connector id', () => {
        const plan = planSink(readyTarget(), {});
        expect(plan.sinkElement).toContain('kmssink name=sink connector-id=32');
        expect(plan.sinkElement).toContain('sync=true max-lateness=1000000000');
        expect(plan.sinkElement).toContain('qos=true');
        expect(plan).toMatchObject({ clockSync: false, sinkPaced: true });
    });

    it('sync=false drops the pacing (and with it the tsparse chain)', () => {
        const plan = planSink(readyTarget(), { sync: false });
        expect(plan.sinkElement).toContain('sync=false');
        expect(plan.sinkPaced).toBe(false);
    });

    it('clockSync forces pacing on even when sync is off', () => {
        const plan = planSink(readyTarget(), { sync: false, clockSync: true });
        expect(plan).toMatchObject({ clockSync: true, sinkPaced: true });
        expect(plan.sinkElement).toContain('sync=true');
    });

    it('converts lipSyncMs to a nanosecond ts-offset on the named sink', () => {
        expect(planSink(readyTarget(), { lipSyncMs: 40 }).sinkElement).toContain(
            'ts-offset=40000000',
        );
    });

    it('passes qos=false through for paced HLS chains', () => {
        expect(planSink(readyTarget(), { qos: false }).sinkElement).toContain('qos=false');
    });
});

describe('resolveResumeSocket', () => {
    beforeEach(() => {
        existsSyncMock.mockReset();
    });

    it('taps the edge socket of a silent source that is still being served', () => {
        existsSyncMock.mockReturnValue(true);
        expect(resolveResumeSocket(true, '/tmp/mr-bus-5500.sock')).toBe('/tmp/mr-bus-5500.sock');
    });

    it('never taps a socket that is gone — the runner gate would hold the bars hostage', () => {
        existsSyncMock.mockReturnValue(false);
        expect(resolveResumeSocket(true, '/tmp/mr-bus-5500.sock')).toBeUndefined();
    });

    it('never taps when the source is not silent (no source at all)', () => {
        existsSyncMock.mockReturnValue(true);
        expect(resolveResumeSocket(false, '/tmp/mr-bus-5500.sock')).toBeUndefined();
        expect(existsSyncMock).not.toHaveBeenCalled();
    });

    it('never taps a source without a socket path', () => {
        expect(resolveResumeSocket(true, undefined)).toBeUndefined();
    });
});

describe('resolveBuildHealth', () => {
    const active = { name: 'HDMI-A-1', connectorId: 32, substituted: false };

    it('names the substituted display first — the most surprising fact', () => {
        expect(
            resolveBuildHealth({
                requestedDisplay: 'DSI-2',
                active: { ...active, substituted: true },
                sourceSilent: true,
                hasSource: true,
            }),
        ).toEqual(['warning', 'Display "DSI-2" not connected — using "HDMI-A-1"']);
    });

    it('reports a silent source', () => {
        expect(
            resolveBuildHealth({
                requestedDisplay: '',
                active,
                sourceSilent: true,
                hasSource: true,
            }),
        ).toEqual(['warning', 'Source silent — showing fallback pattern']);
    });

    it('reports no source at all', () => {
        expect(
            resolveBuildHealth({
                requestedDisplay: '',
                active,
                sourceSilent: false,
                hasSource: false,
            }),
        ).toEqual(['warning', 'No video connected']);
    });

    it('returns a BARE ok — a trailing message would read as an error detail', () => {
        const health = resolveBuildHealth({
            requestedDisplay: '',
            active,
            sourceSilent: false,
            hasSource: true,
        });
        expect(health).toEqual(['ok']);
        expect(health.length).toBe(1);
    });
});

describe('planFallbackPipeline', () => {
    const base = {
        fallbackText: 'No video detected',
        sinkElement: 'kmssink name=sink',
        env: { MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1' },
        surface: DEFAULT_SURFACE,
    };

    it('builds the SMPTE card and reports no active tap', () => {
        const plan = planFallbackPipeline(base);
        expect(plan.resumeTapActive).toBe(false);
        expect(plan.description.pipeline).toContain('videotestsrc');
        expect(plan.description.pipeline).toContain('No video detected');
        expect(plan.description.pipeline).not.toContain('unixfdsrc');
        expect(plan.description.restartOnError).toBe(true);
        expect(plan.description.env).toEqual(base.env);
    });

    it('splices the resume tap in and flags it for the poller', () => {
        const plan = planFallbackPipeline({ ...base, resumeSocket: '/tmp/mr-bus-5500.sock' });
        expect(plan.resumeTapActive).toBe(true);
        expect(plan.description.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-5500.sock');
        expect(plan.description.pipeline).toContain(`fakesink name=${RESUME_SINK_NAME}`);
    });

    it('sizes the card to the surface it was given', () => {
        const plan = planFallbackPipeline({ ...base, surface: { width: 1920, height: 1080 } });
        expect(plan.description.pipeline).toContain('width=1920,height=1080');
    });

    it('uses the still image when one was validated', () => {
        const plan = planFallbackPipeline({ ...base, fallbackImage: '/data/uploads/card.png' });
        expect(plan.description.pipeline).toContain('filesrc location="/data/uploads/card.png"');
        expect(plan.description.pipeline).not.toContain('videotestsrc');
    });

    it('never arms the TS probe on the fallback card', () => {
        expect(planFallbackPipeline(base).description.tsProbe).toBeUndefined();
    });
});

describe('planLivePipeline', () => {
    const base = {
        sinkElement: 'kmssink name=sink',
        udpSource: { port: 5500, socketPath: '/tmp/mr-bus-5500.sock' },
        env: {},
        waylandFullscreen: false,
        decoder: DECODEBIN_SELECTION,
        bufferMs: undefined as unknown,
        cpuDecodeThreading: undefined as unknown,
        clockSync: false,
        sinkPaced: true,
    };

    it('arms the TS probe — the only way the module learns the codec', () => {
        const desc = planLivePipeline(base);
        expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
        expect(desc.pipeline).toContain('appsink name=tsprobe');
    });

    it('watches render keep-up only when the sink is named', () => {
        expect(planLivePipeline(base).renderWatch).toEqual({ sink: 'sink' });
        // autovideosink (dev boxes) is a bin without `name=sink` — the runner
        // would fail the element lookup.
        expect(
            planLivePipeline({ ...base, sinkElement: 'autovideosink' }).renderWatch,
        ).toBeUndefined();
    });

    it('defaults bufferMs to 200 ms and normalises the threading value', () => {
        const desc = planLivePipeline(base);
        expect(desc.pipeline).toContain('max-size-time=200000000');
        // Unset = the `'auto'` default = multi-core, which is the runner's
        // `'frame'`; only `'single'` asks it to leave ffmpeg's choice alone.
        expect(desc.decoderThreadType).toBe('frame');
        expect(planLivePipeline({ ...base, cpuDecodeThreading: 'frame' }).decoderThreadType).toBe(
            'frame',
        );
        expect(planLivePipeline({ ...base, cpuDecodeThreading: 'single' }).decoderThreadType).toBe(
            'auto',
        );
    });

    it('carries bufferMs through as the leaky-queue window', () => {
        expect(planLivePipeline({ ...base, bufferMs: 1500 }).pipeline).toContain(
            'max-size-time=1500000000',
        );
    });

    it('only sets clockSync on the description when it is on', () => {
        expect(planLivePipeline(base).clockSync).toBeUndefined();
        expect(planLivePipeline({ ...base, clockSync: true }).clockSync).toBe(true);
    });

    it('places the explicit decoder chain and its pad-steering caps', () => {
        const decoder: DecoderSelection = {
            id: 'v4l2h264dec',
            chain: `h264parse ! v4l2h264dec name=${VIDEO_DECODER_NAME}`,
            caps: 'capsfilter caps="video/x-h264"',
            hardware: true,
            explicit: true,
        };
        const desc = planLivePipeline({ ...base, decoder });
        expect(desc.pipeline).toContain('capsfilter caps="video/x-h264"');
        expect(desc.pipeline).toContain(`h264parse ! v4l2h264dec name=${VIDEO_DECODER_NAME}`);
        expect(desc.pipeline).not.toContain('decodebin3');
    });

    describe('keyframe gate', () => {
        // A live TS join lands mid-GOP. Delta units before the first keyframe
        // leave a stateless V4L2 decoder holding a decode request that never
        // completes, and the NEXT teardown hangs in the kernel and kills V4L2
        // box-wide (Pi 4 rpivid / Pi 5 hevc_dec, kernel 6.12.87).
        const explicit = (id: string, parser: string): DecoderSelection => ({
            id,
            chain: `${parser} ! ${id} name=${VIDEO_DECODER_NAME}`,
            caps: `capsfilter caps="video/x-${id.includes('265') ? 'h265' : 'h264'}"`,
            hardware: id.startsWith('v4l2'),
            explicit: true,
        });

        it('arms the gate on every explicit rung, naming the decoder in the chain', () => {
            for (const decoder of [
                explicit('v4l2slh265dec', 'h265parse'),
                explicit('avdec_h265', 'h265parse'),
                explicit('v4l2h264dec', 'h264parse'),
                explicit('avdec_h264', 'h264parse'),
            ]) {
                const desc = planLivePipeline({ ...base, decoder });
                expect(desc.keyframeGate, decoder.id).toEqual({ decoder: VIDEO_DECODER_NAME });
                // The runner resolves the element by that exact name — if the
                // chain didn't carry it, `start` would hard-error.
                expect(desc.pipeline).toContain(`name=${VIDEO_DECODER_NAME}`);
            }
        });

        it('never arms it on the decodebin3 rung — there is no element to name', () => {
            // The bin plugs its own decoder, so there is no element name to
            // give the runner and no way to gate it. That rung only carries the
            // stream until the TS probe names the codec.
            const desc = planLivePipeline(base);
            expect(desc.keyframeGate).toBeUndefined();
            expect(desc.pipeline).not.toContain(`name=${VIDEO_DECODER_NAME}`);
        });

        it('never arms it on the fallback card', () => {
            expect(
                planFallbackPipeline({
                    fallbackText: 'No video',
                    sinkElement: 'kmssink name=sink',
                    env: {},
                    surface: DEFAULT_SURFACE,
                }).description.keyframeGate,
            ).toBeUndefined();
        });
    });

    it('drops the software scaler when the compositor scales for us', () => {
        expect(planLivePipeline({ ...base, waylandFullscreen: true }).pipeline).not.toContain(
            'videoscale',
        );
        expect(planLivePipeline(base).pipeline).toContain('videoconvert ! videoscale');
    });

    describe('decodebin3-rung rank mask', () => {
        const explicitDecoder: DecoderSelection = {
            id: 'avdec_h264',
            chain: 'h264parse ! avdec_h264',
            caps: 'capsfilter caps="video/x-h264"',
            hardware: false,
            explicit: true,
        };

        it('sets NO mask on the BOOTSTRAP build — decodebin3 picks by rank', () => {
            // The bootstrap runs before the TS probe has named the codec, so
            // decodebin3 auto-plugs by rank and a box with a hardware decoder
            // uses it, without the pipeline string having to know which box it
            // is on. Only a decoder that has actually failed gets masked out.
            expect(planLivePipeline(base).env).toEqual({});
            expect(planLivePipeline({ ...base, demoted: new Set() }).env).toEqual({});
        });

        it('threads the software decode decodebin3 may still pick', () => {
            // If the box has no hardware decoder the bin plugs avdec_*, which
            // only keeps up if the runner's hook spreads it over cores.
            expect(planLivePipeline(base).decoderThreadType).toBe('frame');
        });

        it('masks exactly the demoted decoders', () => {
            expect(planLivePipeline({ ...base, demoted: new Set(['avdec_h264']) }).env).toEqual({
                GST_PLUGIN_FEATURE_RANK: 'avdec_h264:NONE',
            });
            const desc = planLivePipeline({
                ...base,
                demoted: new Set(['v4l2h264dec', 'avdec_h264']),
            });
            expect(desc.env).toEqual({
                GST_PLUGIN_FEATURE_RANK: 'v4l2h264dec:NONE,avdec_h264:NONE',
            });
        });

        it('MERGES the mask onto the surface env instead of replacing it', () => {
            // MR_GLIB_PRGNAME is how kiosk-shell pins the surface to an output;
            // clobbering it would move the picture to the wrong screen.
            const desc = planLivePipeline({
                ...base,
                env: { MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1' },
                demoted: new Set(['avdec_h264']),
            });
            expect(desc.env).toEqual({
                MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1',
                GST_PLUGIN_FEATURE_RANK: 'avdec_h264:NONE',
            });
        });

        it('leaves the surface env untouched when nothing is demoted', () => {
            const env = { MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1' };
            expect(planLivePipeline({ ...base, env }).env).toEqual(env);
        });

        it('leaves the env alone on an explicit rung, demotions or not', () => {
            const env = { MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1' };
            // Explicit rung: the decoder is named, rank is irrelevant — and
            // masking it would strike out the decoder we just asked for,
            // including the keyframe-gated hardware one.
            expect(
                planLivePipeline({
                    ...base,
                    env,
                    decoder: explicitDecoder,
                    demoted: new Set(['v4l2h264dec']),
                }).env,
            ).toEqual(env);
            expect(planLivePipeline({ ...base, env, decoder: explicitDecoder }).env).toEqual(env);
        });
    });
});

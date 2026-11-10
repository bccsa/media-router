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
import { DEFAULT_SURFACE, RESUME_SINK_NAME, type SinkSelectionEnv } from './pipelines.js';
import {
    DECODEBIN_SELECTION,
    DECODER_ELEMENTS,
    selectDecoder,
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
    it('a sink that shows each frame as it comes: never waits, never drops late, sends no QoS (B-169)', () => {
        expect(planSink(readyTarget()).sinkElement).toBe(
            'kmssink name=sink connector-id=32 sync=false qos=false',
        );
        const wayland = planSink(
            readyTarget({
                sinkEnv: { wayland: true, kms: true, waylandSession: true },
                waylandFullscreen: true,
            }),
        ).sinkElement;
        expect(wayland).toBe(
            'waylandsink name=sink sync=false qos=false present-every-frame=true fullscreen=true',
        );
    });
});

/**
 * The live string on every rung and every sink (house-clock part 4.2, B-169): the bus ingress,
 * the non-leaky ES queue, the decoder, the pace, the render lateness tap, a sink that never waits.
 */
describe('the live string, every rung on every sink', () => {
    const all = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));
    const RUNGS: Record<string, DecoderSelection> = {
        v4l2h264dec: selectDecoder({ codec: 'h264', available: all }),
        avdec_h264: selectDecoder({
            codec: 'h264',
            available: { h264parse: true, avdec_h264: true },
        }),
        v4l2slh265dec: selectDecoder({ codec: 'h265', available: all }),
        avdec_h265: selectDecoder({
            codec: 'h265',
            available: { h265parse: true, avdec_h265: true },
        }),
        decodebin3: DECODEBIN_SELECTION,
    };
    const SINKS: Record<string, { sinkEnv: SinkSelectionEnv; waylandFullscreen: boolean }> = {
        wayland: {
            sinkEnv: { wayland: true, kms: true, waylandSession: true },
            waylandFullscreen: true,
        },
        kms: {
            sinkEnv: { wayland: false, kms: true, waylandSession: false, connectorId: 32 },
            waylandFullscreen: false,
        },
        auto: {
            sinkEnv: { wayland: false, kms: false, waylandSession: false },
            waylandFullscreen: false,
        },
    };
    const build = (sink: string, rung: string): string => {
        const target = readyTarget(SINKS[sink]);
        return planLivePipeline({
            sinkElement: planSink(target).sinkElement,
            udpSource: { port: 5500, socketPath: '/tmp/mr-bus-5500.sock' },
            env: {},
            waylandFullscreen: target.waylandFullscreen,
            decoder: RUNGS[rung],
            cpuDecodeThreading: undefined,
            refreshHz: 50,
        }).pipeline;
    };
    const cases = Object.keys(SINKS).flatMap((sink) =>
        Object.keys(RUNGS).map((rung) => [sink, rung] as const),
    );

    it('tests/pipelines.json holds each (`vitest -u` rewrites it)', async () => {
        expect(new Set(Object.values(RUNGS).map((d) => d.id)).size).toBe(5);
        const out = Object.fromEntries(
            cases.map(([sink, rung]) => [`${sink} ${rung}`, build(sink, rung)]),
        );
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
            '../../tests/pipelines.json',
        );
    });

    it('each: the ES queue non-leaky, the pace right before the tap and the sink, nothing that waits or drops late', () => {
        const sinks = {
            wayland:
                'waylandsink name=sink sync=false qos=false present-every-frame=true fullscreen=true',
            kms: 'kmssink name=sink connector-id=32 sync=false qos=false',
            // A bin: it takes `sync` and no `qos` (a parse error); p4-5's hook reaches its child.
            auto: 'autovideosink sync=false',
        } as Record<string, string>;
        for (const [sink, rung] of cases) {
            const p = build(sink, rung);
            const label = `${sink} ${rung}`;
            expect(p, label).toContain(
                ' ! queue name=vp_esq leaky=0 max-size-time=5000000000 max-size-buffers=0' +
                    ' max-size-bytes=40000000 ! ',
            );
            expect(p, label).toContain(
                ' ! mrvideopace name=vp_pace backlog-queue=vp_esq refresh-mhz=50000 ! ' +
                    `mrlateness name=lat_render reference=running-time ! ${sinks[sink]} vp_ts. ! `,
            );
            expect(p, label).toContain('mrtsdemux name=vpdemux media=video');
            for (const gone of ['ts-offset', 'max-lateness', 'tsparse', 'sync=true', 'qos=true']) {
                expect(p, `${label}: ${gone}`).not.toContain(gone);
            }
            // The one leaky=2 is the bus ingress's backstop; the probe tap's is leaky=downstream.
            expect(p.match(/leaky=2/g), label).toHaveLength(1);
            expect(p, label).toMatch(
                /^unixfdsrc [^!]*! watchdog [^!]*! mrlateness [^!]*! queue leaky=2 /,
            );
            expect(p.match(/leaky=downstream/g), label).toHaveLength(1);
            expect(p.match(/present-every-frame=true/g) ?? [], label).toHaveLength(
                sink === 'wayland' ? 1 : 0,
            );
        }
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
        cpuDecodeThreading: undefined as unknown,
    };

    it('arms the TS probe — the only way the module learns the codec', () => {
        const desc = planLivePipeline(base);
        expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
        expect(desc.pipeline).toContain('appsink name=tsprobe');
    });

    it('adds the subtitle overlay + input only when a subtitle source is wired', () => {
        const plain = planLivePipeline(base);
        expect(plain.pipeline).not.toContain('textoverlay');
        expect(plain.runnerHooks).toBeUndefined();

        const withSubs = planLivePipeline({
            ...base,
            subtitles: {
                port: 5600,
                socketPath: '/tmp/mr-bus-5600-edge.sock',
                config: { subtitlePosition: 'top', subtitleSize: 48 },
            },
        });
        // overlay sits between the convert stage and the pace, driven by config
        expect(withSubs.pipeline).toContain(
            '! videoconvert ! videoscale ! textoverlay name=subov wait-text=false text="" valignment=top ' +
                'halignment=center font-desc="Sans Bold 48" ypad=40 shaded-background=true shading-value=153 ! ' +
                'mrvideopace name=vp_pace backlog-queue=vp_esq ! mrlateness name=lat_render reference=running-time ! kmssink name=sink',
        );
        // the subtitle TS comes in on its own bus edge into a named demux
        expect(withSubs.pipeline).toContain('/tmp/mr-bus-5600-edge.sock');
        expect(withSubs.pipeline).toMatch(/ mrtsdemux name=subdemux media=private$/);
        expect(withSubs.runnerHooks).toEqual([
            {
                module: 'subtitle_bridge',
                config: { overlay: { demux: 'subdemux', overlay: 'subov' } },
            },
        ]);
        // python-only hook by decision (ADR-0016 2026-10-09), not a temporary measure
        expect(withSubs.runner).toBe('python');
        expect(plain.runner).toBeUndefined();
        // everything else about the description is untouched
        expect(withSubs.tsProbe).toEqual(plain.tsProbe);
    });

    it("watches render keep-up only when the sink is named, the pace's rate drops kept up", () => {
        expect(planLivePipeline(base).renderWatch).toEqual({ sink: 'sink', pace: 'vp_pace' });
        // autovideosink (dev boxes) is a bin without `name=sink` — the runner
        // would fail the element lookup.
        expect(
            planLivePipeline({ ...base, sinkElement: 'autovideosink' }).renderWatch,
        ).toBeUndefined();
    });

    it('taps render lateness after the pace, right before the sink, and names it for the timing section', () => {
        const desc = planLivePipeline(base);
        expect(desc.pipeline).toContain(
            'mrvideopace name=vp_pace backlog-queue=vp_esq ! mrlateness name=lat_render reference=running-time ! kmssink name=sink',
        );
        expect(desc.timingSink).toEqual({ element: 'sink', kind: 'video' });
        expect(
            planLivePipeline({ ...base, sinkElement: 'autovideosink' }).timingSink,
        ).toBeUndefined();
    });

    it('carries the output mode refresh to the timing sink, and to the pace as its prior', () => {
        const desc = planLivePipeline({ ...base, refreshHz: 50 });
        expect(desc.timingSink).toEqual({ element: 'sink', kind: 'video', refreshHz: 50 });
        expect(desc.pipeline).toContain(
            'mrvideopace name=vp_pace backlog-queue=vp_esq refresh-mhz=50000 ! ',
        );
        // The Pi 5 box's DSI, 60.038 Hz to the 0.01 Hz the mode resolver gives.
        expect(planLivePipeline({ ...base, refreshHz: 60.04 }).pipeline).toContain(
            'mrvideopace name=vp_pace backlog-queue=vp_esq refresh-mhz=60040 ! ',
        );
        // Unknown: no prior, the pace measures the display itself (B-175).
        expect(planLivePipeline(base).pipeline).toContain(
            'mrvideopace name=vp_pace backlog-queue=vp_esq ! ',
        );
    });

    it('rebuilds a failing pipeline at most every 30 s, from 1 s', () => {
        // Each rebuild opens the decoder again; rapid opens wedged the Pi 4's VPU (DEV-P4b).
        const desc = planLivePipeline(base);
        expect(desc.restartOnError).toBe(true);
        expect(desc.restartBackoffMs).toEqual({ baseMs: 1_000, maxMs: 30_000 });
    });

    it("runs on the runners' clock: base time 0 and start time none, never a natural base", () => {
        // A natural base re-bases running time at a flushing seek, and the pace then holds the
        // frames caught across it for seconds (DEV-P4b on the Pi 5 box: 18 ms on the runners').
        expect(planLivePipeline(base).liveCaptureClock).toBeUndefined();
    });

    it('normalises the threading value', () => {
        const desc = planLivePipeline(base);
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

    it('places the explicit decoder chain behind its codec filter', () => {
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

    it('demuxes video only on every rung, an explicit one behind its codec filter (Q18)', () => {
        const all = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));
        const software = { h264parse: true, avdec_h264: true, h265parse: true, avdec_h265: true };
        const rungs = [
            DECODEBIN_SELECTION,
            ...['h264', 'h265'].flatMap((codec) => [
                selectDecoder({ codec, available: all }),
                selectDecoder({ codec, available: software }),
            ]),
        ];
        expect(new Set(rungs.map((d) => d.id)).size).toBe(5);
        for (const decoder of rungs) {
            const desc = planLivePipeline({ ...base, decoder });
            const filter = decoder.caps ? `${decoder.caps} ! ` : '';
            expect(desc.pipeline, decoder.id).toContain(
                `! tee name=vp_ts ! mrtsdemux name=vpdemux media=video ! ${filter}queue name=vp_esq leaky=0 `,
            );
            expect(desc.pipeline, decoder.id).not.toMatch(/\btsdemux\b/);
        }
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

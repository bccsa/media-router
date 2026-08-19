import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

// The module probes the producer's edge socket (no-tap resume mode) via the
// engine's probeUnixSocket — mock just that export so tests control the
// probe verdict without touching real unix sockets.
vi.mock('@media-router/engine', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        probeUnixSocket: vi.fn(async () => false),
        // The kernel-log watch is the engine's; the plugin only subscribes.
        // Stubbing it keeps the tests off /dev/kmsg and hands us the handler.
        onKernelLogSignal: vi.fn(),
        // Passthrough spies so headless-guard tests can inject connector
        // states; on dev machines the real ones read /sys/class/drm → [].
        listDrmConnectors: vi.fn(actual.listDrmConnectors as (...a: unknown[]) => unknown),
        firstConnectedDisplay: vi.fn(actual.firstConnectedDisplay as (...a: unknown[]) => unknown),
    };
});

// buildPipeline gates the fallback's resume tap on fs.existsSync(edge socket).
// Wrap just that export in a pass-through spy so stall tests can force the
// verdict; every other fs API (and existsSync by default) stays real for the
// tmpdir-based wayland/cog tests below.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import {
    firstConnectedDisplay,
    listDrmConnectors,
    onKernelLogSignal,
    probeUnixSocket,
    type KernelLogSignalEvent,
} from '@media-router/engine';
import { VideoPlayerModule } from './VideoPlayerModule.js';
import { bootNowMs, currentWaylandSessionIdent, findCogPidForDisplay } from './helpers/wayland.js';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildPipelineEnv,
    buildSink,
    resolveDecoderThreadType,
    resolveFallbackImagePath,
    RESUME_SINK_NAME,
    surfaceCaps,
} from './helpers/pipelines.js';
import {
    DECODER_ELEMENTS,
    HARDWARE_DECODER_IDS,
    KERNEL_HW_DECODE_DISABLED_NOTE,
    selectDecoder,
} from './helpers/decoderSelection.js';
import { DEFAULT_DEMOTION_TTL_MS, DEMOTION_TTL_ENV_VAR } from './helpers/decoderDemotions.js';

const probeUnixSocketMock = probeUnixSocket as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

describe('VideoPlayerModule helpers', () => {
    beforeEach(() => {
        // Reset any cached probe state so each test sets its own.
        VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
        // No decoder elements + no demotions by default: every build that
        // doesn't opt in resolves to the decodebin3 rung, i.e. today's pipeline.
        VideoPlayerModule._test_resetDecoderState();
        // Deterministic DRM default: no connectors = dev-machine path, so the
        // headless guard never fires from the box the tests happen to run on
        // (a headless Pi has connectors that are all `disconnected`, which
        // would return null from every buildPipeline call). Guard tests
        // override with mockReturnValueOnce.
        (listDrmConnectors as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (firstConnectedDisplay as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    });

    describe('buildSink', () => {
        const both = { wayland: true, kms: true };
        it('prefers waylandsink (fullscreen) when a compositor session is reachable', () => {
            // fullscreen=true is what makes kiosk-shell (a) raise the video
            // above an interactive cog browser on the same output, and
            // (b) apply the output's transform itself, so we don't pre-rotate.
            expect(buildSink('', { ...both, waylandSession: true })).toBe(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
            );
            // ignores `display` config: compositor decides output
            expect(buildSink('HDMI-A-1', { ...both, waylandSession: true })).toBe(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
            );
        });
        it('targets kmssink by numeric connector-id (older kmssink builds reject connector-name)', () => {
            expect(buildSink('HDMI-A-1', { ...both, waylandSession: false, connectorId: 32 })).toBe(
                'kmssink name=sink connector-id=32 sync=false qos=true',
            );
        });
        it('falls back to auto-pick kmssink when the connector id can not be resolved', () => {
            // Picked a display but sysfs lookup returned undefined — better to
            // auto-pick than emit `connector-name=...` which older kmssink
            // builds reject with a parse error.
            expect(buildSink('HDMI-A-1', { ...both, waylandSession: false })).toBe(
                'kmssink name=sink sync=false qos=true',
            );
        });
        it('uses kmssink without a connector when display is unset', () => {
            expect(buildSink('', { ...both, waylandSession: false })).toBe(
                'kmssink name=sink sync=false qos=true',
            );
        });
        it('falls back to autovideosink when neither sink is installed', () => {
            expect(buildSink('', { wayland: false, kms: false, waylandSession: false })).toBe(
                'autovideosink sync=false qos=true',
            );
        });
        it('uses kmssink even with a compositor present when waylandsink is missing', () => {
            expect(
                buildSink('HDMI-A-1', {
                    wayland: false,
                    kms: true,
                    waylandSession: true,
                    connectorId: 32,
                }),
            ).toBe('kmssink name=sink connector-id=32 sync=false qos=true');
        });

        it('always returns the fullscreen waylandsink for wayland (rotation is the compositor’s job)', () => {
            // No client-side rotation any more: as a fullscreen surface the
            // compositor applies the output transform. So the sink string is
            // the same regardless of the physical output orientation.
            expect(buildSink('DSI-2', { ...both, waylandSession: true })).toBe(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
            );
        });

        // sync=true is the HLS branch — paired with max-lateness=1 s (1e9 ns) to
        // sit between two failure modes: the basesink 20 ms default loses every
        // GOP-boundary frame on Pi 5 software-decoded 1080p (low fps), and `-1`
        // (disabled) lets sustained decode shortfall accumulate as unbounded lag.
        // 1 s absorbs IDR-frame jitter while capping latency. The pair must
        // appear on every sink variant or the HLS path silently regresses.
        describe('lip-sync trim (ts-offset)', () => {
            const env = { wayland: false, kms: true, waylandSession: false, connectorId: 32 };
            it('adds ts-offset to the sink when sync=true and an offset is set', () => {
                const s = buildSink('HDMI-A-1', env, { sync: true, tsOffsetNs: 1_000_000_000 });
                expect(s).toContain('ts-offset=1000000000');
                expect(s).toContain('sync=true');
            });
            it('omits ts-offset when sync is off (a non-syncing sink ignores timing)', () => {
                const s = buildSink('HDMI-A-1', env, { sync: false, tsOffsetNs: 1_000_000_000 });
                expect(s).not.toContain('ts-offset');
            });
            it('omits ts-offset when the trim is 0', () => {
                const s = buildSink('HDMI-A-1', env, { sync: true, tsOffsetNs: 0 });
                expect(s).not.toContain('ts-offset');
            });
        });

        describe('with sync=true (HLS branch)', () => {
            it('emits sync=true max-lateness=1000000000 on waylandsink', () => {
                expect(buildSink('', { ...both, waylandSession: true }, { sync: true })).toBe(
                    'waylandsink name=sink sync=true max-lateness=1000000000 fullscreen=true qos=true',
                );
            });
            it('emits sync=true max-lateness=1000000000 on kmssink with connector-id', () => {
                expect(
                    buildSink(
                        'HDMI-A-1',
                        { ...both, waylandSession: false, connectorId: 32 },
                        { sync: true },
                    ),
                ).toBe(
                    'kmssink name=sink connector-id=32 sync=true max-lateness=1000000000 qos=true',
                );
            });
            it('emits sync=true max-lateness=1000000000 on auto-pick kmssink', () => {
                expect(buildSink('', { ...both, waylandSession: false }, { sync: true })).toBe(
                    'kmssink name=sink sync=true max-lateness=1000000000 qos=true',
                );
            });
            it('emits sync=true max-lateness=1000000000 on autovideosink', () => {
                expect(
                    buildSink(
                        '',
                        { wayland: false, kms: false, waylandSession: false },
                        { sync: true },
                    ),
                ).toBe('autovideosink sync=true max-lateness=1000000000 qos=true');
            });
            it('composes with qos=false (the full HLS knob combo)', () => {
                // sync=true qos=false is what the operator picks for HLS — the
                // sink honours PTS (no fast/slow oscillation) AND doesn't ask
                // the decoder to drop. max-lateness=1000000000 covers the third leg.
                expect(
                    buildSink('', { ...both, waylandSession: true }, { sync: true, qos: false }),
                ).toBe(
                    'waylandsink name=sink sync=true max-lateness=1000000000 fullscreen=true qos=false',
                );
            });
        });
    });

    describe('buildFallbackOnlyPipeline', () => {
        it('renders videotestsrc + textoverlay into the sink (no image path)', () => {
            const s = buildFallbackOnlyPipeline('No video', 'autovideosink sync=false qos=true');
            expect(s).toContain('videotestsrc');
            expect(s).toContain('pattern=smpte');
            expect(s).toContain('textoverlay name=nov text="No video"');
            expect(s).toContain('autovideosink');
            expect(s).not.toContain('filesrc');
        });

        it('renders filesrc + imagefreeze when an image path is provided', () => {
            // Custom-image branch: a single decoded frame held by imagefreeze
            // and scaled to the same 1280×720 the SMPTE branch uses, so the
            // overlay and sink chain are identical between the two variants.
            const s = buildFallbackOnlyPipeline(
                'Standby',
                'autovideosink sync=false qos=true',
                '/data/media-router/no-signal.png',
            );
            expect(s).toContain('filesrc location="/data/media-router/no-signal.png"');
            expect(s).toContain('decodebin');
            expect(s).toContain('imagefreeze');
            expect(s).toContain('width=1280,height=720');
            // Aspect-preserving: `add-borders=true` letterboxes / pillarboxes
            // instead of stretching a non-16:9 image to fill the surface.
            expect(s).toContain('videoscale add-borders=true');
            // PAR=1/1 is paired with add-borders so the bars are real
            // square-pixel space — without it `videoscale` would satisfy
            // the requested display AR by emitting non-square pixels, and
            // the downstream textoverlay would render at the same skewed
            // PAR (regression: portrait-image squashed-text bug).
            expect(s).toContain('pixel-aspect-ratio=1/1');
            expect(s).toContain('textoverlay name=nov text="Standby"');
            expect(s).not.toContain('videotestsrc');
        });

        it('omits the bus-resume tap when no resume socket is given', () => {
            const s = buildFallbackOnlyPipeline('No video', 'autovideosink sync=false qos=true');
            expect(s).not.toContain('unixfdsrc');
            expect(s).not.toContain(RESUME_SINK_NAME);
        });

        it('appends the bus-resume tap (unixfdsrc → leaky queue → named fakesink) when a resume socket is given', () => {
            // The tap keeps draining this module's own fan-out edge while the
            // colour bars are up, so the module can poll `resume_sink` for byte
            // progress (source resumed) without tearing the fallback down —
            // the bus-native replacement for the old passive dgram probe.
            const s = buildFallbackOnlyPipeline(
                'No video',
                'autovideosink sync=false qos=true',
                undefined,
                '/tmp/mr-bus-5500-abc.sock',
            );
            expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-5500-abc.sock');
            // Leaky so the tap can never back-pressure the producer's edge.
            expect(s).toContain(
                'queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0',
            );
            expect(s).toContain(`fakesink name=${RESUME_SINK_NAME} sync=false async=false`);
            // Side chain, not spliced into the render path: the visible chain
            // still ends at the sink, the tap follows after it.
            expect(s.indexOf('autovideosink')).toBeLessThan(s.indexOf('unixfdsrc'));
            // The fallback video branch is still intact.
            expect(s).toContain('videotestsrc');
            expect(s).toContain('textoverlay name=nov');
        });
    });

    describe('resolveFallbackImagePath', () => {
        let tmp: string;
        let imageFile: string;

        beforeEach(() => {
            tmp = fs.mkdtempSync(`${os.tmpdir()}/mr-fbimg-`);
            imageFile = `${tmp}/no-signal.png`;
            fs.writeFileSync(imageFile, 'fake-png-bytes');
        });
        afterEach(() => {
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        it('returns undefined for an empty path', () => {
            expect(resolveFallbackImagePath('')).toBeUndefined();
        });

        it('returns undefined for a relative path', () => {
            // Relative paths resolve against the engine's CWD which is not
            // a stable contract for operators — reject to fail loudly.
            expect(resolveFallbackImagePath('images/foo.png')).toBeUndefined();
        });

        it('returns undefined when the file does not exist', () => {
            expect(resolveFallbackImagePath('/nonexistent/no-signal.png')).toBeUndefined();
        });

        it('returns the path for a readable absolute file', () => {
            expect(resolveFallbackImagePath(imageFile)).toBe(imageFile);
        });

        it('rejects paths containing characters that would break the gst-launch string', () => {
            // `"`, `\`, `\r`, `\n` would terminate the location="…" clause or
            // inject parser tokens. Real kiosk paths don't need them.
            const dangerous = `${tmp}/has"quote.png`;
            fs.writeFileSync(dangerous, '');
            expect(resolveFallbackImagePath(dangerous)).toBeUndefined();
        });
    });

    describe('resolveDecoderThreadType', () => {
        it('asks the runner to force frame threading for every value but "single"', () => {
            // The runner's `'frame'` is what threads the decoder decodebin3
            // auto-plugs on the bootstrap rung — the counterpart of the inline
            // properties on the explicit rungs.
            expect(resolveDecoderThreadType('auto')).toBe('frame');
            expect(resolveDecoderThreadType('frame')).toBe('frame');
        });

        it('defaults to the threaded mapping when unset or junk (the setting default is "auto")', () => {
            expect(resolveDecoderThreadType(undefined)).toBe('frame');
            expect(resolveDecoderThreadType('slice')).toBe('frame');
            expect(resolveDecoderThreadType('')).toBe('frame');
            expect(resolveDecoderThreadType(1)).toBe('frame');
            expect(resolveDecoderThreadType(null)).toBe('frame');
        });

        it('leaves ffmpeg\'s live default alone on "single" — the runner\'s "auto"', () => {
            // The two vocabularies disagree about `'auto'` on purpose: this is
            // the one setting value that maps onto the runner's do-not-force.
            expect(resolveDecoderThreadType('single')).toBe('auto');
        });
    });

    describe('buildLivePipeline', () => {
        const busSource = { port: 5000, socketPath: '/tmp/mr-bus-5000-abc.sock' };

        it('wires unixfdsrc → tsdemux → decodebin → sink off the bus edge socket', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
            expect(s).toContain('unixfdsrc socket-path=/tmp/mr-bus-5000-abc.sock');
            expect(s).toContain('tsdemux');
            expect(s).toContain('decodebin');
            expect(s).toContain('kmssink name=sink');
            // No UDP ingress remains — unixfd is the only bus transport.
            expect(s).not.toContain('udpsrc');
            // No fallback branch when a source is connected.
            expect(s).not.toContain('input-selector');
            expect(s).not.toContain('videotestsrc');
        });

        it('has NO tsparse — the player never re-muxes, and the default sink presents on arrival', () => {
            // tsparse's job (re-anchoring PCR so multi-stage remux chains don't
            // drift) doesn't apply to a terminal display pipeline, and it was
            // the chain's single most expensive element (0.11 core at 1080p50,
            // measured 2026-08-01). tsdemux consumes the bus buffers directly.
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
            expect(s).not.toContain('tsparse');
        });

        it('clock-paced sink (sync config) brings tsparse back but rides the source PTS (set-timestamps=false)', () => {
            // tsparse returns for TS packet alignment and the vp_ts probe tee,
            // but NEVER re-anchors: this fleet's muxes carry PCR at up to 2 s
            // intervals, so set-timestamps=true bursts whole GOPs and paces at
            // ~1 fps (field-measured 2026-08-09). The sink rides the source PTS.
            const s = buildLivePipeline(
                'kmssink name=sink sync=true max-lateness=1000000000 qos=true',
                busSource,
                false,
                200,
                false,
                true,
            );
            expect(s).toContain('tsparse set-timestamps=false');
            expect(s).not.toContain('set-timestamps=true');
        });

        it('clockSync keeps tsparse and preserves the source timeline (set-timestamps=false)', () => {
            const s = buildLivePipeline(
                'kmssink name=sink sync=true max-lateness=1000000000 qos=true',
                busSource,
                false,
                200,
                true,
                true,
            );
            expect(s).toContain('tsparse set-timestamps=false');
            expect(s).not.toContain('set-timestamps=true');
        });

        it('keeps videoscale (uncapped) on the KMS/auto path — no compositor scales for them', () => {
            // kmssink/autovideosink negotiate the size they want and there is
            // nothing downstream to resize for them, so the scaler stays.
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
            expect(s).toContain('videoconvert ! videoscale ! kmssink');
            // Still uncapped: a native-res broadcast panel must not be rescaled.
            expect(s).not.toContain('width=');
        });

        it('drops videoscale AND all size caps on the wayland-fullscreen path', () => {
            // Weston (kiosk-shell fullscreen) fit-scales the surface on the GPU
            // for free, so scaling in software here would pay for it twice: the
            // frames reach waylandsink at SOURCE resolution.
            const s = buildLivePipeline(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
                busSource,
                true,
            );
            expect(s).toContain(
                'decodebin3 ! videoconvert ! waylandsink name=sink sync=false fullscreen=true qos=true',
            );
            expect(s).not.toContain('videoscale');
            expect(s).not.toContain('width=');
            expect(s).not.toContain('height=');
            expect(s).not.toContain('pixel-aspect-ratio');
        });

        it('needs no DMABuf caps hole for a hw decoder — nothing constrains the sink caps', () => {
            // `v4l2slh265dec` (rpivid) only ever emits
            // video/x-raw(memory:DMABuf), format=DMA_DRM. The old two-structure
            // filter needed an explicit no-constraint DMABuf structure to let
            // those buffers past a size only the software path could satisfy;
            // with no caps filter at all they negotiate straight through
            // videoconvert (which passes DMA_DRM untouched) to waylandsink.
            const s = buildLivePipeline(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
                busSource,
                true,
            );
            expect(s).not.toContain('memory:DMABuf');
            expect(s).not.toContain('video/x-raw');
        });

        it('never uses the ISP (v4l2convert) on either path', () => {
            // Measured on Pi 400: the bcm2835 ISP caps at ~46 fps for 1080p
            // regardless of output size — it cannot sustain 1080p50, where the
            // software elements run ~60 fps at near-zero CPU as long as they
            // are not asked to resize (basetransform goes passthrough).
            expect(
                buildLivePipeline('waylandsink name=sink fullscreen=true', busSource, true),
            ).not.toContain('v4l2convert');
            expect(buildLivePipeline('kmssink name=sink', busSource, false)).not.toContain(
                'v4l2convert',
            );
        });

        it('leaves the live surface source-sized while the fallback card stays surface-sized', () => {
            // ACCEPTED RISK, asserted so the divergence stays deliberate and
            // visible: kiosk-shell can reject a fullscreen surface whose size
            // differs from the one already committed to the output
            // (`libwayland: error in client communication`), so a live↔fallback
            // transition between differing dimensions can trip it. Revisit with
            // the fallback-sizing strategy (handover Q5).
            const surface = { width: 1920, height: 1080 };
            const live = buildLivePipeline('waylandsink name=sink', busSource, true);
            const fb = buildFallbackOnlyPipeline(
                'No video',
                'waylandsink name=sink',
                undefined,
                undefined,
                surface,
            );
            expect(live).not.toContain('width=1920,height=1080');
            expect(fb).toContain('width=1920,height=1080');
        });

        it('arms a 5s stall watchdog on the bus ingress so a silent producer trips bus_stall', () => {
            // The watchdog element replaces udpsrc's `timeout` property: the
            // runner matches the `buswd` prefix on its ERROR and tags it
            // `kind: 'bus_stall'`, which the module latches into fallback.
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
            expect(s).toContain('watchdog name=buswd_5000 timeout=5000');
        });

        it('orders unixfdsrc → watchdog → tsdemux (watchdog sees raw socket delivery)', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
            const idxSrc = s.indexOf('unixfdsrc');
            const idxWd = s.indexOf('watchdog');
            const idxTsdemux = s.indexOf('tsdemux');
            expect(idxSrc).toBeLessThan(idxWd);
            expect(idxWd).toBeLessThan(idxTsdemux);
        });

        describe('TS video-info tap', () => {
            it('tees the ingress just before tsdemux into a leaky-queue appsink', () => {
                // Tap point is the ingress (tsInput), for two reasons: the
                // probe wants the MUXED TS (it does its own PSI discovery), and
                // it puts the branch downstream of the stall watchdog so it
                // cannot interfere with bus_stall detection.
                const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
                expect(s).toContain('! tee name=vp_ts ! tsdemux');
                expect(s).toContain(
                    'vp_ts. ! queue leaky=downstream max-size-buffers=64 ! appsink name=tsprobe',
                );
                expect(s.indexOf('watchdog')).toBeLessThan(s.indexOf('tee name=vp_ts'));
            });

            it('taps the same spot on the clock-paced variant (after tsparse)', () => {
                // The paced chain inserts tsparse ahead of the tee; the tap is
                // still the last thing before tsdemux. It does NOT depend on
                // tsparse for 188-byte alignment — the bus delivers whole-packet
                // buffers on both variants (unixfd preserves producer buffer
                // boundaries), which is what `ts_psi.iter_packets` needs since
                // it strides a fixed 188 and never resyncs on 0x47.
                const s = buildLivePipeline(
                    'kmssink name=sink sync=true qos=true',
                    busSource,
                    false,
                    200,
                    false,
                    true,
                );
                expect(s).toContain('tsparse set-timestamps=false ! tee name=vp_ts ! tsdemux');
                expect(s).toContain('appsink name=tsprobe');
            });

            it('hangs the tap off the end as a side chain, never in the render path', () => {
                const s = buildLivePipeline('kmssink name=sink sync=false qos=true', busSource);
                expect(s.indexOf('kmssink name=sink')).toBeLessThan(s.indexOf('appsink'));
                // Leaky + the runner's drop=true appsink: the tap can never
                // back-pressure the render branch through the tee.
                expect(s).toContain('leaky=downstream');
            });
        });

        describe('explicit decoder chains', () => {
            const all = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));
            const wayland = 'waylandsink name=sink sync=false fullscreen=true qos=true';
            const kms = 'kmssink name=sink sync=false qos=true';

            it('bootstraps on decodebin3 with NO capsfilter when no codec is known', () => {
                // Byte-for-byte the pipeline the player has always built (plus
                // the probe tap that discovers the codec in the first place).
                const s = buildLivePipeline(wayland, busSource, true);
                expect(s).toContain(
                    'tsdemux latency=0 ! queue leaky=2 max-size-time=1000000000 ' +
                        'max-size-buffers=0 max-size-bytes=0 ! decodebin3 ! videoconvert ! ' +
                        wayland,
                );
                expect(s).not.toContain('capsfilter');
                expect(s).not.toContain('h264parse');
                expect(s).not.toContain('h265parse');
            });

            it('builds h264parse ! v4l2h264dec on the wayland path (no videoscale)', () => {
                const s = buildLivePipeline(
                    wayland,
                    busSource,
                    true,
                    200,
                    false,
                    false,
                    selectDecoder({ codec: 'h264', available: all }),
                );
                expect(s).toContain(
                    'tsdemux latency=0 ! capsfilter caps="video/x-h264" ! ' +
                        'queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0 ! ' +
                        'h264parse ! v4l2h264dec name=vpdec ! videoconvert ! ' +
                        wayland,
                );
                expect(s).not.toContain('decodebin');
                expect(s).not.toContain('videoscale');
            });

            it('builds h265parse ! v4l2slh265dec on the KMS path (videoconvert ! videoscale)', () => {
                const s = buildLivePipeline(
                    kms,
                    busSource,
                    false,
                    200,
                    false,
                    false,
                    selectDecoder({ codec: 'h265', available: all }),
                );
                expect(s).toContain(
                    'capsfilter caps="video/x-h265" ! ' +
                        'queue leaky=2 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0 ! ' +
                        'h265parse ! v4l2slh265dec name=vpdec ! videoconvert ! videoscale ! ' +
                        kms,
                );
            });

            it('inlines avdec frame threading and honours bufferMs on the software rung', () => {
                const s = buildLivePipeline(
                    kms,
                    busSource,
                    false,
                    1500,
                    false,
                    false,
                    selectDecoder({
                        codec: 'h265',
                        available: { h265parse: true, avdec_h265: true },
                        threading: 'frame',
                    }),
                );
                expect(s).toContain(
                    'h265parse ! avdec_h265 name=vpdec thread-type=frame max-threads=3 ! videoconvert',
                );
                // bufferMs still sizes both the jitter queue and the
                // post-demux leaky queue — unchanged by the decoder swap.
                expect(s).toContain('max-size-time=1500000000');
            });

            it('threads the software rung on the default (auto) threading', () => {
                const s = buildLivePipeline(
                    kms,
                    busSource,
                    false,
                    200,
                    false,
                    false,
                    selectDecoder({
                        codec: 'h264',
                        available: { h264parse: true, avdec_h264: true },
                    }),
                );
                expect(s).toContain(
                    'h264parse ! avdec_h264 name=vpdec thread-type=frame max-threads=3 ! videoconvert',
                );
            });

            it('leaves the software rung bare on "single"', () => {
                const s = buildLivePipeline(
                    kms,
                    busSource,
                    false,
                    200,
                    false,
                    false,
                    selectDecoder({
                        codec: 'h264',
                        available: { h264parse: true, avdec_h264: true },
                        threading: 'single',
                    }),
                );
                expect(s).toContain('h264parse ! avdec_h264 name=vpdec ! videoconvert');
                expect(s).not.toContain('thread-type');
            });

            it('puts the capsfilter DIRECTLY on tsdemux, before the leaky queue', () => {
                // The queue's sink pad is ANY, so it would accept an AUDIO pad
                // from tsdemux just as happily as the video one — and the audio
                // then reaches h26xparse/videoconvert and kills the pipeline
                // with "Internal data stream error". Steering has to happen at
                // the first pad the demuxer can link to.
                const s = buildLivePipeline(
                    kms,
                    busSource,
                    false,
                    200,
                    false,
                    false,
                    selectDecoder({ codec: 'h264', available: all }),
                );
                // Slice from tsdemux so the pre-tsparse jitter queue (same
                // 200 ms bound) can't be mistaken for the post-demux one.
                const afterDemux = s.slice(s.indexOf('tsdemux'));
                expect(afterDemux.indexOf('capsfilter')).toBeLessThan(
                    afterDemux.indexOf('queue leaky=2'),
                );
                expect(afterDemux.indexOf('queue leaky=2')).toBeLessThan(
                    afterDemux.indexOf('h264parse'),
                );
            });

            it('keeps the probe tap, watchdog and PTS handling on an explicit chain', () => {
                const s = buildLivePipeline(
                    wayland,
                    busSource,
                    true,
                    200,
                    true,
                    true,
                    selectDecoder({ codec: 'h265', available: all }),
                );
                expect(s).toContain('watchdog name=buswd_5000 timeout=5000');
                expect(s).toContain('tsparse set-timestamps=false');
                expect(s).toContain('appsink name=tsprobe');
            });
        });
    });

    describe('surfaceCaps', () => {
        it('pins the fallback card to the given size at square pixels', () => {
            expect(surfaceCaps({ width: 1920, height: 1080 })).toBe(
                'video/x-raw,width=1920,height=1080,pixel-aspect-ratio=1/1',
            );
        });

        it('defaults to the 1280x720 fallback surface when none is given', () => {
            expect(surfaceCaps()).toBe('video/x-raw,width=1280,height=720,pixel-aspect-ratio=1/1');
        });

        it('leaves the fallback pipeline system-memory only (no DMABuf structure)', () => {
            // videotestsrc / imagefreeze never produce DMABuf, and the fallback
            // card is sized here rather than inherited — so a DMABuf structure
            // would be meaningless on this path.
            const fb = buildFallbackOnlyPipeline(
                'No video',
                'waylandsink name=sink',
                undefined,
                undefined,
                { width: 1920, height: 1080 },
            );
            expect(fb).not.toContain('memory:DMABuf');
            expect(fb).toContain('video/x-raw,width=1920,height=1080,pixel-aspect-ratio=1/1');
        });
    });

    describe('buildPipelineEnv', () => {
        const wayland = { wayland: true, kms: true, waylandSession: true };
        it('emits MR_GLIB_PRGNAME on the wayland path with a display set', () => {
            // weston.ini whitelists `local.mr.<connector>` per output; the
            // Python runner's `GLib.set_prgname` then pins the wayland
            // surface to that output.
            expect(buildPipelineEnv('HDMI-A-1', wayland)).toEqual({
                MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1',
            });
            expect(buildPipelineEnv('DSI-2', wayland)).toEqual({
                MR_GLIB_PRGNAME: 'local.mr.DSI-2',
            });
        });
        it('returns an empty env when no display is configured', () => {
            // Don't override the runner's inherited env with an empty value —
            // an unset display leaves output selection up to the compositor
            // (matching previous behaviour for legacy / unconfigured hosts).
            expect(buildPipelineEnv('', wayland)).toEqual({});
        });
        it('returns an empty env on the KMS path even with a display set', () => {
            // kmssink ignores the wayland app_id — emitting it would leak a
            // confusing prgname into process listings without driving output
            // selection. Same for autovideosink (no wayland/no kms host).
            expect(
                buildPipelineEnv('HDMI-A-1', {
                    wayland: false,
                    kms: true,
                    waylandSession: false,
                }),
            ).toEqual({});
            // Compositor not reachable — the buildSink layer would also fall
            // through to kmssink, so the env would be moot here too.
            expect(
                buildPipelineEnv('HDMI-A-1', {
                    wayland: true,
                    kms: true,
                    waylandSession: false,
                }),
            ).toEqual({});
        });
    });

    describe('buildPipeline', () => {
        function makeModule() {
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleBusSource: vi.fn() },
            };
            (module as any).setHealth = vi.fn();
            return module;
        }

        it('returns a fallback-only pipeline when no source is connected', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
            const desc = module.buildPipeline({ fallbackText: 'Nothing here', display: '' })!;
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).toContain('Nothing here');
            expect(desc.pipeline).not.toContain('input-selector');
            // Empty display → no env override (let the compositor decide).
            expect(desc.env).toEqual({});
            expect((module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('No video'),
            );
        });

        describe('headless guard', () => {
            const listDrmConnectorsMock = listDrmConnectors as unknown as ReturnType<typeof vi.fn>;
            const firstConnectedDisplayMock = firstConnectedDisplay as unknown as ReturnType<
                typeof vi.fn
            >;

            it('returns no pipeline and flags health=error when DRM exists but nothing is connected', () => {
                // A sink would only error-loop here: kmssink has no connector
                // to drive, and the compositor itself can't start without a
                // display. The manager UI shows the health message instead.
                VideoPlayerModule.setSinkAvailability({ wayland: true, kms: true });
                const module = makeModule();
                listDrmConnectorsMock.mockReturnValueOnce([
                    { name: 'HDMI-A-1', label: '', meta: { status: 'disconnected' } },
                    { name: 'Writeback-1', label: '', meta: { status: 'connected' } },
                ]);
                firstConnectedDisplayMock.mockReturnValueOnce(undefined);
                const desc = module.buildPipeline({ fallbackText: 'No video', display: '' });
                expect(desc).toBeNull();
                expect((module as any).setHealth).toHaveBeenCalledWith(
                    'error',
                    expect.stringContaining('No display connected'),
                );
            });

            it('honours an explicitly selected connector that is connected (e.g. Writeback capture)', () => {
                VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
                const module = makeModule();
                (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
                listDrmConnectorsMock.mockReturnValueOnce([
                    { name: 'Writeback-1', label: '', meta: { status: 'connected' } },
                ]);
                firstConnectedDisplayMock.mockReturnValueOnce(undefined);
                const desc = module.buildPipeline({
                    fallbackText: 'No video',
                    display: 'Writeback-1',
                });
                expect(desc).not.toBeNull();
                expect(desc!.pipeline).toContain('videotestsrc');
            });

            it('waits for the compositor instead of falling back to kmssink (display connected, no session)', () => {
                // kmssink would take the DRM master and fight the starting
                // compositor for it — the hotplug flash-then-vanish failure.
                VideoPlayerModule.setSinkAvailability({ wayland: true, kms: true });
                const prevRuntime = process.env.XDG_RUNTIME_DIR;
                delete process.env.XDG_RUNTIME_DIR; // no session reachable
                try {
                    const module = makeModule();
                    listDrmConnectorsMock.mockReturnValueOnce([
                        { name: 'HDMI-A-1', label: '', meta: { status: 'connected' } },
                    ]);
                    firstConnectedDisplayMock.mockReturnValueOnce('HDMI-A-1');
                    const desc = module.buildPipeline({ fallbackText: 'x', display: '' });
                    expect(desc).toBeNull();
                    expect((module as any).setHealth).toHaveBeenCalledWith(
                        'warning',
                        expect.stringContaining('waiting for compositor'),
                    );
                } finally {
                    if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
                }
            });

            it('skips the guard on hosts with no DRM subsystem at all (dev machines)', () => {
                VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
                const module = makeModule();
                (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
                listDrmConnectorsMock.mockReturnValueOnce([]);
                const desc = module.buildPipeline({ fallbackText: 'No video', display: '' });
                expect(desc).not.toBeNull();
                expect(desc!.pipeline).toContain('autovideosink');
            });
        });

        it('returns the live pipeline when a bus source is assigned (KMS path)', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue({
                port: 5500,
                socketPath: '/tmp/mr-bus-5500-abc.sock',
                connectionId: 'enc-1:mpegts-out-player-1:mpegts-in',
                sourceModuleId: 'enc-1',
                sourcePortId: 'mpegts-out',
            });
            const desc = module.buildPipeline({
                fallbackText: 'No video',
                display: 'HDMI-A-1',
            })!;
            expect(desc.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-5500-abc.sock');
            expect(desc.pipeline).toContain('watchdog name=buswd_5500 timeout=5000');
            expect(desc.pipeline).toContain('tsdemux');
            expect(desc.pipeline).toContain('decodebin');
            // On a test machine without /sys/class/drm, resolveConnectorId returns
            // undefined → kmssink falls back to auto-pick (no connector-id prop).
            expect(desc.pipeline).toContain('kmssink name=sink');
            expect(desc.pipeline).not.toContain('connector-name=');
            expect(desc.pipeline).not.toContain('videotestsrc');
            // KMS path → no wayland app-id env. The pinning mechanism doesn't
            // apply here (kmssink picks the connector directly), and leaking
            // a prgname into process listings would just be confusing. Nothing
            // is demoted, so the decodebin3 rung carries no rank mask either.
            expect(desc.env).toEqual({});
        });

        it('carries MR_GLIB_PRGNAME into the env on the Wayland path', () => {
            // Verifies the integration: when both waylandsink is available and
            // a compositor socket is reachable, the env field on the returned
            // PipelineDescription is populated so the Python runner can pin
            // the wayland surface to the user-selected connector.
            VideoPlayerModule.setSinkAvailability({ wayland: true, kms: true });
            const prevRuntime = process.env.XDG_RUNTIME_DIR;
            const tmpRuntime = fs.mkdtempSync(`${os.tmpdir()}/mr-wl-test-`);
            fs.writeFileSync(`${tmpRuntime}/wayland-1`, '');
            process.env.XDG_RUNTIME_DIR = tmpRuntime;
            try {
                const module = makeModule();
                (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
                const desc = module.buildPipeline({
                    fallbackText: 'No video',
                    display: 'DSI-2',
                })!;
                expect(desc.pipeline).toContain('waylandsink name=sink');
                expect(desc.env).toEqual({ MR_GLIB_PRGNAME: 'local.mr.DSI-2' });
            } finally {
                fs.rmSync(tmpRuntime, { recursive: true, force: true });
                if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
                else delete process.env.XDG_RUNTIME_DIR;
            }
        });
    });

    describe('currentWaylandSessionIdent', () => {
        let tmp: string;
        beforeEach(() => {
            tmp = fs.mkdtempSync(`${os.tmpdir()}/mr-wl-ident-`);
        });
        afterEach(() => {
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        it('returns "" when no wayland socket is present', () => {
            expect(currentWaylandSessionIdent(tmp)).toBe('');
        });

        it('returns "<name>:<inode>" when a wayland socket exists', () => {
            const sockPath = path.join(tmp, 'wayland-1');
            fs.writeFileSync(sockPath, '');
            const expectedInode = fs.statSync(sockPath).ino;
            expect(currentWaylandSessionIdent(tmp)).toBe(`wayland-1:${expectedInode}`);
        });

        it('returns a different ident after the socket file is replaced (compositor restart)', () => {
            // Models the Weston restart sequence: unlink old socket, create
            // new one. Inode changes even when the filename is reused. This
            // change-detection is what the watcher uses to decide whether to
            // kick a pipeline restart.
            const sockPath = path.join(tmp, 'wayland-1');
            fs.writeFileSync(sockPath, '');
            const first = currentWaylandSessionIdent(tmp);
            fs.unlinkSync(sockPath);
            fs.writeFileSync(sockPath, '');
            const second = currentWaylandSessionIdent(tmp);
            expect(first).not.toBe('');
            expect(second).not.toBe('');
            expect(second).not.toBe(first);
        });

        it('returns "" for a missing runtime dir', () => {
            expect(currentWaylandSessionIdent('/nonexistent-runtime-xyz')).toBe('');
        });
    });

    describe('findCogPidForDisplay', () => {
        let tmp: string;
        beforeEach(() => {
            tmp = fs.mkdtempSync(`${os.tmpdir()}/mr-cog-`);
        });
        afterEach(() => {
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        function fakeProc(pid: number, cmdline: string): void {
            const dir = path.join(tmp, String(pid));
            fs.mkdirSync(dir);
            // Kernel /proc/$pid/cmdline uses NUL separators between argv items,
            // not spaces — match that so the helper's substring search behaves
            // the same here as on a real Linux box.
            fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.replace(/ /g, '\0'));
        }

        it('returns undefined for an empty display name', () => {
            fakeProc(
                123,
                '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2',
            );
            expect(findCogPidForDisplay('', tmp)).toBeUndefined();
        });

        it('returns the PID of the cog instance pinned to the given connector', () => {
            fakeProc(
                101,
                '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2',
            );
            fakeProc(
                202,
                '/usr/bin/cog http://localhost:8083/background --gapplication-app-id=local.cog.HDMI-A-1',
            );
            expect(findCogPidForDisplay('HDMI-A-1', tmp)).toBe(202);
            expect(findCogPidForDisplay('DSI-2', tmp)).toBe(101);
        });

        it('returns undefined when no cog is running for the requested display', () => {
            fakeProc(
                101,
                '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2',
            );
            expect(findCogPidForDisplay('HDMI-A-2', tmp)).toBeUndefined();
        });

        it('ignores WPE helper subprocesses (they do not carry the app-id arg)', () => {
            // The WPENetworkProcess / WPEWebProcess children inherit a different
            // argv that lacks `--gapplication-app-id`, so the substring match
            // naturally skips them. Verify a cmdline that mentions cog but not
            // the right connector is not picked up.
            fakeProc(300, '/usr/libexec/wpe-webkit-2.0/WPEWebProcess 11 21 23');
            fakeProc(301, '/usr/libexec/wpe-webkit-2.0/WPENetworkProcess 1 7 10');
            expect(findCogPidForDisplay('HDMI-A-1', tmp)).toBeUndefined();
        });

        it('skips non-numeric /proc entries (devices, self, etc.)', () => {
            fs.mkdirSync(path.join(tmp, 'self'));
            fs.writeFileSync(path.join(tmp, 'self', 'cmdline'), 'irrelevant');
            fakeProc(
                404,
                '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2',
            );
            expect(findCogPidForDisplay('DSI-2', tmp)).toBe(404);
        });

        it('returns undefined for a missing /proc root', () => {
            expect(findCogPidForDisplay('DSI-2', '/nonexistent-proc-xyz')).toBeUndefined();
        });
    });

    describe('wayland-restart watcher', () => {
        // Hard-fakes the lifecycle: register two instances against a tmp
        // runtime dir, swap the socket inode, fire the debounced check, and
        // assert each instance's restart hook ran exactly once.
        let tmp: string;
        let prevRuntime: string | undefined;

        beforeEach(() => {
            tmp = fs.mkdtempSync(`${os.tmpdir()}/mr-wl-watcher-`);
            prevRuntime = process.env.XDG_RUNTIME_DIR;
            process.env.XDG_RUNTIME_DIR = tmp;
            VideoPlayerModule._test_resetWaylandWatcher();
        });

        afterEach(() => {
            VideoPlayerModule._test_resetWaylandWatcher();
            fs.rmSync(tmp, { recursive: true, force: true });
            if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
            else delete process.env.XDG_RUNTIME_DIR;
        });

        function makeRunningInstance(): { module: VideoPlayerModule; onStop: any; onStart: any } {
            const module = new VideoPlayerModule();
            const onStop = vi.spyOn(module as any, 'onStop').mockResolvedValue(undefined);
            const onStart = vi.spyOn(module as any, 'onStart').mockImplementation(async () => {
                // Re-register after restart, mirroring real onStart behaviour.
                (VideoPlayerModule as any).registerForWaylandRestartWatch(module);
            });
            (VideoPlayerModule as any).registerForWaylandRestartWatch(module);
            return { module, onStop, onStart };
        }

        it('restarts every registered instance when the wayland socket inode changes', async () => {
            const sockPath = path.join(tmp, 'wayland-1');
            fs.writeFileSync(sockPath, '');
            const a = makeRunningInstance();
            const b = makeRunningInstance();
            expect(VideoPlayerModule._test_getRunningInstances().size).toBe(2);

            // Simulate compositor restart: socket replaced.
            fs.unlinkSync(sockPath);
            fs.writeFileSync(sockPath, '');

            VideoPlayerModule._test_triggerWaylandCheck();
            await new Promise((r) => setTimeout(r, 700)); // > debounce window
            // Restart cycle is async; let onStop+onStart microtasks settle.
            await new Promise((r) => setImmediate(r));

            expect(a.onStop).toHaveBeenCalledTimes(1);
            expect(a.onStart).toHaveBeenCalledTimes(1);
            expect(b.onStop).toHaveBeenCalledTimes(1);
            expect(b.onStart).toHaveBeenCalledTimes(1);
        });

        it('does not restart instances when a spurious event fires without an actual socket change', async () => {
            const sockPath = path.join(tmp, 'wayland-1');
            fs.writeFileSync(sockPath, '');
            const inst = makeRunningInstance();

            // No file change between the watcher install (which captured the
            // current ident) and the check — same inode, no restart.
            VideoPlayerModule._test_triggerWaylandCheck();
            await new Promise((r) => setTimeout(r, 700));
            await new Promise((r) => setImmediate(r));

            expect(inst.onStop).not.toHaveBeenCalled();
            expect(inst.onStart).not.toHaveBeenCalled();
        });

        it('latches per-instance so concurrent socket flaps coalesce into one restart cycle', async () => {
            const sockPath = path.join(tmp, 'wayland-1');
            fs.writeFileSync(sockPath, '');
            const inst = makeRunningInstance();

            // Two replacements; debounce + latch should still produce one cycle.
            fs.unlinkSync(sockPath);
            fs.writeFileSync(sockPath, '');
            VideoPlayerModule._test_triggerWaylandCheck();
            fs.unlinkSync(sockPath);
            fs.writeFileSync(sockPath, '');
            VideoPlayerModule._test_triggerWaylandCheck();
            await new Promise((r) => setTimeout(r, 700));
            await new Promise((r) => setImmediate(r));

            // The second debounce-check sees the new ident and would fire a
            // second restart cycle, but the per-instance `pipelineRestartInProgress`
            // latch in restartForWaylandSessionChange clamps it to one stop/start
            // pair as long as the first cycle is still in flight.
            expect(inst.onStop.mock.calls.length).toBeLessThanOrEqual(2);
            expect(inst.onStart.mock.calls.length).toBeLessThanOrEqual(2);
        });
    });

    describe('restartPipeline convergence', () => {
        it('re-runs one follow-up cycle when a trigger lands mid-restart (stall→resume race)', async () => {
            const module = new VideoPlayerModule();
            let releaseFirstStop!: () => void;
            const firstStopGate = new Promise<void>((r) => (releaseFirstStop = r));
            const onStop = vi
                .spyOn(module as any, 'onStop')
                .mockImplementationOnce(async () => {
                    await firstStopGate;
                })
                .mockResolvedValue(undefined);
            const onStart = vi.spyOn(module as any, 'onStart').mockResolvedValue(undefined);

            const first = (module as any).restartPipeline(); // stall → fallback build
            await (module as any).restartPipeline(); // resume lands mid-flight — must queue
            releaseFirstStop();
            await first;

            // Two full cycles: the queued resume trigger re-runs stop/start so
            // buildPipeline sees the post-resume state instead of freezing on
            // the stale fallback.
            expect(onStop).toHaveBeenCalledTimes(2);
            expect(onStart).toHaveBeenCalledTimes(2);
        });

        it('coalesces several mid-flight triggers into a single follow-up cycle', async () => {
            const module = new VideoPlayerModule();
            let releaseFirstStop!: () => void;
            const firstStopGate = new Promise<void>((r) => (releaseFirstStop = r));
            const onStop = vi
                .spyOn(module as any, 'onStop')
                .mockImplementationOnce(async () => {
                    await firstStopGate;
                })
                .mockResolvedValue(undefined);
            vi.spyOn(module as any, 'onStart').mockResolvedValue(undefined);

            const first = (module as any).restartPipeline();
            await (module as any).restartPipeline();
            await (module as any).restartPipeline();
            await (module as any).restartPipeline();
            releaseFirstStop();
            await first;

            expect(onStop).toHaveBeenCalledTimes(2);
        });
    });

    describe('bus-stall fallback', () => {
        const busSource = { port: 5500, socketPath: '/tmp/mr-bus-5500-abc.sock' };

        function makeModule() {
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleBusSource: vi.fn(() => busSource) },
            };
            (module as any).setHealth = vi.fn();
            (module as any).log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
            return module;
        }

        afterEach(() => {
            // mockReset restores the creation-time implementations (vitest 3):
            // probe → resolves false, existsSync → real fs passthrough.
            probeUnixSocketMock.mockReset();
            existsSyncMock.mockReset();
            vi.restoreAllMocks();
        });

        it('returns the live pipeline by default when a source is connected', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            const desc = module.buildPipeline({ display: '' })!;
            // Sanity: with no stall latched, live wins.
            expect(desc.pipeline).toContain('unixfdsrc');
            expect(desc.pipeline).not.toContain('videotestsrc');
        });

        it('a bus_stall error latches the flag and triggers a fallback rebuild', () => {
            // The runner tags the stall watchdog's ERROR `kind: 'bus_stall'`.
            // gst-runner's restartOnError would replay the same live pipeline,
            // so the module must latch + trigger a full restart so
            // buildPipeline is re-called with the flag set.
            const module = makeModule();
            const restart = vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
            const child = { on: vi.fn() };
            (module as any).childProcess = child;
            (module as any).installBusStallListener();
            const errorHandler = child.on.mock.calls.find((c) => c[0] === 'error')![1];

            errorHandler({ kind: 'other', message: 'not a stall' });
            expect((module as any).busStallDetected).toBe(false);
            expect(restart).not.toHaveBeenCalled();

            errorHandler({ kind: 'bus_stall', message: 'buswd_5500: no data' });
            expect((module as any).busStallDetected).toBe(true);
            expect(restart).toHaveBeenCalledTimes(1);
            expect((module as any).busResumeWatchdog).not.toBeNull();

            // A repeat stall while already latched must not re-trigger.
            errorHandler({ kind: 'bus_stall' });
            expect(restart).toHaveBeenCalledTimes(1);

            (module as any).clearBusStallState();
        });

        it('latched + edge socket exists → fallback carries the resume tap', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).busStallDetected = true;
            existsSyncMock.mockReturnValue(true);
            const desc = module.buildPipeline({ display: '', fallbackText: 'Source down' })!;
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).toContain('Source down');
            expect(desc.pipeline).toContain(`unixfdsrc socket-path=${busSource.socketPath}`);
            expect(desc.pipeline).toContain(`fakesink name=${RESUME_SINK_NAME}`);
            expect((module as any).resumeTapActive).toBe(true);
            expect((module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('Source silent'),
            );
        });

        it('latched but edge socket missing (producer down) → fallback without the tap', () => {
            // A missing socket must not enter the pipeline: the runner's
            // bus-socket gate would hold the colour bars hostage waiting for
            // a dead producer to serve it.
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).busStallDetected = true;
            existsSyncMock.mockReturnValue(false);
            const desc = module.buildPipeline({ display: '', fallbackText: 'Source down' })!;
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).not.toContain('unixfdsrc');
            expect(desc.pipeline).not.toContain(RESUME_SINK_NAME);
            expect((module as any).resumeTapActive).toBe(false);
        });

        it('no-source fallback never carries a tap even when a socket file exists', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
            existsSyncMock.mockReturnValue(true);
            const desc = module.buildPipeline({ display: '' })!;
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).not.toContain('unixfdsrc');
            expect((module as any).resumeTapActive).toBe(false);
        });

        describe('pollBusResume (tap mode)', () => {
            it('clears the latch and restarts live when the tap byte counter advances', async () => {
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = true;
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const readBytes = vi
                    .spyOn(module as any, 'readBusSinkBytes')
                    .mockResolvedValue(1000);

                // First tick: baseline only — no previous sample to compare.
                await (module as any).pollBusResume();
                expect(readBytes).toHaveBeenCalledWith(RESUME_SINK_NAME);
                expect(restart).not.toHaveBeenCalled();
                expect((module as any).busStallDetected).toBe(true);

                // Counter flat: still stalled.
                await (module as any).pollBusResume();
                expect(restart).not.toHaveBeenCalled();

                // Counter advancing — but resume waits for a STABLE streak
                // (RESUME_STABLE_POLLS consecutive flowing polls) so the live
                // pipeline doesn't rebuild against a still-churning source.
                readBytes.mockResolvedValue(2000);
                await (module as any).pollBusResume();
                expect(restart).not.toHaveBeenCalled();
                readBytes.mockResolvedValue(3000);
                await (module as any).pollBusResume();
                expect(restart).not.toHaveBeenCalled();
                readBytes.mockResolvedValue(4000);
                await (module as any).pollBusResume();
                expect((module as any).busStallDetected).toBe(false);
                expect(restart).toHaveBeenCalledTimes(1);
                expect((module as any).busResumeWatchdog).toBeNull();
            });

            it('a flat poll mid-streak resets the stability gate', async () => {
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = true;
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const readBytes = vi
                    .spyOn(module as any, 'readBusSinkBytes')
                    .mockResolvedValue(1000);
                await (module as any).pollBusResume(); // baseline
                readBytes.mockResolvedValue(2000);
                await (module as any).pollBusResume(); // streak 1
                readBytes.mockResolvedValue(3000);
                await (module as any).pollBusResume(); // streak 2
                await (module as any).pollBusResume(); // flat → streak 0
                readBytes.mockResolvedValue(4000);
                await (module as any).pollBusResume(); // streak 1
                readBytes.mockResolvedValue(5000);
                await (module as any).pollBusResume(); // streak 2
                expect(restart).not.toHaveBeenCalled();
                expect((module as any).busStallDetected).toBe(true);
            });

            it('does nothing while a restart cycle is already in flight', async () => {
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = true;
                (module as any).pipelineRestartInProgress = true;
                const readBytes = vi.spyOn(module as any, 'readBusSinkBytes');
                await (module as any).pollBusResume();
                expect(readBytes).not.toHaveBeenCalled();
            });
        });

        describe('resume baseline seeded at PLAYING', () => {
            /** Let the fire-and-forget seed settle (real timers here). */
            const flush = () => new Promise((r) => setTimeout(r, 0));

            it('the card reaching PLAYING takes the baseline, so the first poll already counts', async () => {
                // `total_bytes` counts from probe install, so there is no "0" to
                // assume — the baseline has to be READ. Reading it when the tap
                // element appears rather than on the poller's first tick is a
                // whole second off the interlude, with the settle gate intact.
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = true;
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const readBytes = vi
                    .spyOn(module as any, 'readBusSinkBytes')
                    .mockResolvedValue(1000);

                (module as any).onPipelinePlaying();
                await flush();
                expect(readBytes).toHaveBeenCalledWith(RESUME_SINK_NAME);
                expect((module as any).lastResumeBytes).toBe(1000);

                // RESUME_STABLE_POLLS ADVANCING observations, exactly as before
                // — no tick spent on a baseline.
                readBytes.mockResolvedValue(2000);
                await (module as any).pollBusResume();
                readBytes.mockResolvedValue(3000);
                await (module as any).pollBusResume();
                expect(restart).not.toHaveBeenCalled();
                readBytes.mockResolvedValue(4000);
                await (module as any).pollBusResume();
                expect((module as any).busStallDetected).toBe(false);
                expect(restart).toHaveBeenCalledTimes(1);
            });

            it('never overwrites a baseline the poller already took', async () => {
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = true;
                (module as any).lastResumeBytes = 5000;
                vi.spyOn(module as any, 'readBusSinkBytes').mockResolvedValue(10);
                (module as any).onPipelinePlaying();
                await flush();
                expect((module as any).lastResumeBytes).toBe(5000);
            });

            it('does not read anything on the live chain, or once the latch is clear', async () => {
                const module = makeModule();
                const readBytes = vi.spyOn(module as any, 'readBusSinkBytes');
                // Live chain: there is no tap element to read.
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = false;
                (module as any).onPipelinePlaying();
                // Source already back: nothing to carry into the next stall.
                (module as any).busStallDetected = false;
                (module as any).resumeTapActive = true;
                (module as any).onPipelinePlaying();
                await flush();
                expect(readBytes).not.toHaveBeenCalled();
            });
        });

        describe('pollBusResume (no-tap mode)', () => {
            it('probes the edge socket and retries live once it answers', async () => {
                const module = makeModule();
                (module as any).busStallDetected = true;
                (module as any).resumeTapActive = false;
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);

                probeUnixSocketMock.mockResolvedValue(false);
                await (module as any).pollBusResume();
                expect(probeUnixSocketMock).toHaveBeenCalledWith(busSource.socketPath);
                expect(restart).not.toHaveBeenCalled();
                expect((module as any).busStallDetected).toBe(true);

                // Producer respawned — socket answers on 3 consecutive
                // polls (the stability gate) → retry live directly.
                probeUnixSocketMock.mockResolvedValue(true);
                await (module as any).pollBusResume();
                await (module as any).pollBusResume();
                expect(restart).not.toHaveBeenCalled();
                await (module as any).pollBusResume();
                expect((module as any).busStallDetected).toBe(false);
                expect(restart).toHaveBeenCalledTimes(1);
            });
        });

        it('external stop wipes the stall state; internal restart preserves the latch', async () => {
            const module = makeModule();

            // Internal restart cycle: onStop runs with the in-progress latch
            // set — the stall flag must survive so the rebuilt pipeline picks
            // the fallback that triggered this very restart.
            (module as any).busStallDetected = true;
            (module as any).resumeTapActive = true;
            (module as any).pipelineRestartInProgress = true;
            await module.onStop();
            expect((module as any).busStallDetected).toBe(true);

            // External stop (user disabled / engine shutdown): fresh start
            // must never inherit a stale fallback decision.
            (module as any).pipelineRestartInProgress = false;
            (module as any).startBusResumeWatchdog();
            await module.onStop();
            expect((module as any).busStallDetected).toBe(false);
            expect((module as any).resumeTapActive).toBe(false);
            expect((module as any).busResumeWatchdog).toBeNull();
        });

        it('installBusStallListener re-arms the resume poller when the latch survived an internal restart', () => {
            const module = makeModule();
            (module as any).busStallDetected = true;
            (module as any).childProcess = null; // rebuild may have failed — poller must still run
            (module as any).installBusStallListener();
            expect((module as any).busResumeWatchdog).not.toBeNull();
            (module as any).clearBusStallState();
        });
    });

    describe('codec-aware decoder selection', () => {
        // sourceModuleId/sourcePortId identify the producer EDGE — the key the
        // codec memory is filed under (see helpers/codecMemory.ts).
        const busSource = {
            port: 5500,
            socketPath: '/tmp/mr-bus-5500-abc.sock',
            sourceModuleId: 'ts-input-1',
            sourcePortId: 'mpegts-out',
        };
        const all = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));

        function makeModule() {
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleBusSource: vi.fn(() => busSource) },
            };
            (module as any).setHealth = vi.fn();
            (module as any).log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
            (module as any).config = {};
            return module;
        }

        /** Drive one full build the way onStart would, and return the desc. */
        function build(module: VideoPlayerModule, config: Record<string, unknown> = {}) {
            (module as any).config = { display: '', ...config };
            return module.buildPipeline((module as any).config)!;
        }

        beforeEach(() => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            VideoPlayerModule.setDecoderAvailability(all);
        });

        afterEach(() => {
            VideoPlayerModule._test_resetDecoderState();
            vi.restoreAllMocks();
        });

        describe('bootstrap → upgrade', () => {
            it('builds decodebin3 and arms the TS probe before any videoinfo has arrived', () => {
                const module = makeModule();
                const desc = build(module);
                expect(desc.pipeline).toContain('decodebin3');
                expect(desc.pipeline).not.toContain('h264parse');
                // The probe is what makes the upgrade possible at all.
                expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
                expect(desc.pipeline).toContain('appsink name=tsprobe');
            });

            it('rebuilds with the explicit chain when the probe reports a codec', () => {
                const module = makeModule();
                build(module); // bootstrap: decodebin3
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);

                (module as any).onPluginEvent('tsprobe:videoinfo', {
                    pid: 256,
                    codec: 'h264',
                    display: null,
                });
                expect(restart).toHaveBeenCalledTimes(1);

                // The rebuild (restartPipeline → onStart → buildPipeline) now
                // sees the remembered codec and plugs the hardware decoder.
                const desc = build(module);
                expect(desc.pipeline).toContain('capsfilter caps="video/x-h264"');
                expect(desc.pipeline).toContain('h264parse ! v4l2h264dec');
                expect(desc.pipeline).not.toContain('decodebin3');
            });

            it('does not rebuild when the same codec is reported again (debounce)', () => {
                const module = makeModule();
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                build(module); // the rebuild
                expect(restart).toHaveBeenCalledTimes(1);

                // Steady state: the probe re-emits on every SPS change.
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                (module as any).onPluginEvent('tsprobe:videoinfo', {
                    codec: 'h265',
                    width: 1920,
                    height: 1080,
                });
                expect(restart).toHaveBeenCalledTimes(1);
            });

            it('does not rebuild for a codec that resolves to the rung already running', () => {
                // mpeg2 has no ladder → decodebin3, which is what bootstrap
                // already built. Tearing the picture down for that is pure loss.
                const module = makeModule();
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'mpeg2' });
                expect(restart).not.toHaveBeenCalled();
            });

            it('ignores other channels and payloads without a codec', () => {
                const module = makeModule();
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).onPluginEvent('level:sclevel', { codec: 'h264' });
                (module as any).onPluginEvent('tsprobe:videoinfo', {});
                (module as any).onPluginEvent('tsprobe:videoinfo', null);
                expect(restart).not.toHaveBeenCalled();
            });

            it('threads the software rung it picks by default (cpuDecodeThreading unset)', () => {
                const module = makeModule();
                VideoPlayerModule.setDecoderAvailability({ h264parse: true, avdec_h264: true });
                (module as any).detectedCodec = 'h264';
                const desc = build(module);
                expect(desc.pipeline).toContain(
                    'h264parse ! avdec_h264 name=vpdec thread-type=frame max-threads=3',
                );
                // Still handed to the runner: it stays load-bearing on the
                // decodebin3 rung, where GStreamer auto-plugs the decoder.
                expect(desc.decoderThreadType).toBe('frame');
            });

            it('honours cpuDecodeThreading="single" on the software rung it picks', () => {
                const module = makeModule();
                VideoPlayerModule.setDecoderAvailability({ h264parse: true, avdec_h264: true });
                (module as any).detectedCodec = 'h264';
                const desc = build(module, { cpuDecodeThreading: 'single' });
                expect(desc.pipeline).toContain('h264parse ! avdec_h264 name=vpdec ! videoconvert');
                expect(desc.pipeline).not.toContain('thread-type');
                // And the runner is told not to force one either, so the bare
                // element keeps ffmpeg's single-core live default.
                expect(desc.decoderThreadType).toBe('auto');
            });

            it('gates the explicit rung on the first keyframe, never the bootstrap rung', () => {
                // End to end through the real module: mid-GOP stream entry on a
                // stateless V4L2 decoder leaves the kernel driver holding a
                // decode request that never completes, and the next teardown
                // hangs V4L2 box-wide (Pi 4 rpivid / Pi 5 hevc_dec, 6.12.87).
                const module = makeModule();
                // Bootstrap (no codec yet) = decodebin3: parsebin gates stream
                // entry there, and there is no decoder element to name.
                expect(build(module).keyframeGate).toBeUndefined();

                (module as any).detectedCodec = 'h265';
                const desc = build(module);
                expect(desc.keyframeGate).toEqual({ decoder: 'vpdec' });
                // The gated element has to exist in the string the runner parses.
                expect(desc.pipeline).toContain('v4l2slh265dec name=vpdec');
            });
        });

        describe('codec change', () => {
            it('rebuilds with the new codec’s chain on h265 → h264', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                const first = build(module);
                expect(first.pipeline).toContain('h265parse ! v4l2slh265dec');
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);

                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h264' });
                expect(restart).toHaveBeenCalledTimes(1);

                const second = build(module);
                expect(second.pipeline).toContain('h264parse ! v4l2h264dec');
                expect(second.pipeline).toContain('capsfilter caps="video/x-h264"');
                expect(second.pipeline).not.toContain('h265');
            });

            it('rebuilds down to decodebin3 when the new codec has no ladder', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h264';
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'mpeg2' });
                expect(restart).toHaveBeenCalledTimes(1);
                const desc = build(module);
                expect(desc.pipeline).toContain('decodebin3');
                expect(desc.pipeline).not.toContain('capsfilter');
            });

            it('remembers the codec across an internal restart, and clears the instance state on an external stop', async () => {
                // Internal restart (compositor flap, cog respawn, stall/resume)
                // must not pay the bootstrap hop again.
                const module = makeModule();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                (module as any).pipelineRestartInProgress = true;
                await module.onStop();
                expect((module as any).detectedCodec).toBe('h265');
                expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');

                // External stop wipes the INSTANCE state — the shared codec
                // memory is what puts it back, and only per producer edge.
                (module as any).pipelineRestartInProgress = false;
                await module.onStop();
                expect((module as any).detectedCodec).toBeUndefined();
            });

            it('starts on the explicit chain after an EXTERNAL restart against the same source', async () => {
                // The churn cost this removes: every moduleRestart used to
                // bootstrap on decodebin3, which auto-plugs (and a second later
                // kills) a hardware decoder for a codec the engine already knew.
                const module = makeModule();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                (module as any).pipelineRestartInProgress = false;
                await module.onStop();

                const restarted = makeModule(); // external restart = fresh instance
                const desc = build(restarted);
                expect(desc.pipeline).toContain('h265parse ! v4l2slh265dec');
                expect(desc.pipeline).not.toContain('decodebin3');
                // The probe is still armed, so a codec CHANGE is caught as ever.
                expect(desc.tsProbe).toEqual({ appsink: 'tsprobe' });
                const restart = vi
                    .spyOn(restarted as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (restarted as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h264' });
                expect(restart).toHaveBeenCalledTimes(1);
                expect(build(restarted).pipeline).toContain('h264parse ! v4l2h264dec');
            });

            it('bootstraps on decodebin3 when the module is rewired to a different source', () => {
                // A rewire is exactly the case the external-stop wipe existed
                // for: the new feed may be anything, so it must not inherit a
                // chain built for the old one.
                const module = makeModule();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                const rewired = makeModule();
                (rewired as any).services.mediaRouter.getModuleBusSource.mockReturnValue({
                    ...busSource,
                    sourceModuleId: 'ts-input-2',
                });
                expect(build(rewired).pipeline).toContain('decodebin3');
            });

            it('a bus_stall forgets the codec, so the post-resume build bootstraps', async () => {
                // An upstream encoder flipping h265→h264 goes quiet while it
                // restarts, which is what trips the 5 s stall watchdog. Starting
                // the resumed feed on the REMEMBERED codec would open the HEVC
                // hardware decoder against an h264 stream and kill it a second
                // later — the open/kill cycle that leaves the Pi's HEVC block
                // dirty — and buys nothing: the probe corrects it either way.
                const module = makeModule();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');

                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const child = { on: vi.fn() };
                (module as any).childProcess = child;
                (module as any).installBusStallListener();
                const onError = child.on.mock.calls.find((c: unknown[]) => c[0] === 'error')![1];
                onError({ kind: 'bus_stall', message: 'buswd_5500: no data' });

                // Instance state gone…
                expect((module as any).detectedCodec).toBeUndefined();
                expect((module as any).liveDecoderCodec).toBeUndefined();
                // …and the shared memory for THIS edge too, so a fresh instance
                // on the same edge doesn't hand the guess straight back.
                expect(build(makeModule()).pipeline).toContain('decodebin3');

                // The resumed live build bootstraps, and the probe's first
                // report puts it on the right explicit chain (one rebuild).
                (module as any).busStallDetected = false;
                const resumed = build(module);
                expect(resumed.pipeline).toContain('decodebin3');
                expect(resumed.tsProbe).toEqual({ appsink: 'tsprobe' });
                restart.mockClear();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h264' });
                expect(restart).toHaveBeenCalledTimes(1);
                expect(build(module).pipeline).toContain('h264parse ! v4l2h264dec');
                (module as any).clearBusStallState();
            });

            it('a NON-stall internal restart keeps the codec — that is what the memory is for', async () => {
                // Compositor flap / cog restack / renderwatch self-heal say
                // nothing about the feed, so they must still skip the bootstrap.
                const module = makeModule();
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h265' });
                (module as any).pipelineRestartInProgress = true;
                await module.onStop();
                expect((module as any).detectedCodec).toBe('h265');
                expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                // And an external stop still leaves the SHARED memory usable.
                (module as any).pipelineRestartInProgress = false;
                await module.onStop();
                expect(build(makeModule()).pipeline).toContain('h265parse ! v4l2slh265dec');
            });

            it('keeps the fallback card free of any decoder record', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h264';
                (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
                const desc = build(module);
                expect(desc.pipeline).toContain('videotestsrc');
                expect(desc.tsProbe).toBeUndefined();
                expect((module as any).liveDecoder).toBeUndefined();
            });
        });

        describe('runtime demotion', () => {
            /** Attach the module's own error listener to a fake child process. */
            function errorHandlerFor(module: VideoPlayerModule) {
                const child = { on: vi.fn() };
                (module as any).childProcess = child;
                (module as any).installBusStallListener();
                return child.on.mock.calls.find((c: unknown[]) => c[0] === 'error')![1] as (
                    d: unknown,
                ) => void;
            }

            it('demotes a failed hardware decoder and rebuilds on software', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                expect(build(module).pipeline).toContain('v4l2slh265dec');
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const onError = errorHandlerFor(module);

                // Observed for real on this hardware: rpivid rejects a stream
                // it cannot decode, mid-playback. `element` is the gst bus
                // message's source, which is what attributes the failure.
                onError({
                    message: 'Driver does not support the selected stream.',
                    element: 'v4l2slh265dec0',
                });

                expect([...VideoPlayerModule.getDemotedDecoders()]).toEqual(['v4l2slh265dec']);
                expect(restart).toHaveBeenCalledTimes(1);
                // Warning, not error — the picture keeps playing one rung down.
                expect((module as any).setHealth).toHaveBeenCalledWith(
                    'warning',
                    'Hardware decoder v4l2slh265dec failed — using software decode (avdec_h265)',
                );
                expect(build(module).pipeline).toContain('h265parse ! avdec_h265');
            });

            it('keeps the demotion note up across the rebuild (not a one-frame flash)', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                build(module);
                vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
                errorHandlerFor(module)({
                    message: 'Driver does not support…',
                    element: 'v4l2slh265dec0',
                });

                // The rebuild sets health ok for a healthy live source; the
                // note has to be re-applied after it or the operator never
                // sees that the box dropped to software decode.
                build(module);
                expect((module as any).setHealth).toHaveBeenLastCalledWith(
                    'warning',
                    'Hardware decoder v4l2slh265dec failed — using software decode (avdec_h265)',
                );
            });

            it('leaves health ok for a codec whose ladder has no demotions', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                build(module);
                vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
                errorHandlerFor(module)({
                    message: 'Driver does not support…',
                    element: 'v4l2slh265dec0',
                });

                // Same engine session, but this stream is h264 — its hardware
                // decoder was never demoted, so no degraded-path warning.
                (module as any).detectedCodec = 'h264';
                build(module);
                expect((module as any).setHealth).toHaveBeenLastCalledWith('ok');
            });

            it('walks the whole ladder down to decodebin3 across repeated failures', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h264';
                build(module);
                vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
                const onError = errorHandlerFor(module);

                onError({ message: 'decode failed', element: 'v4l2h264dec0' });
                const software = build(module);
                expect(software.pipeline).toContain('h264parse ! avdec_h264');
                // Explicit rung: the decoder is named outright, so no rank
                // override — masking it would strike out our own choice.
                expect(software.env?.GST_PLUGIN_FEATURE_RANK).toBeUndefined();

                onError({ message: 'decode failed', element: 'avdec_h2640' });
                const desc = build(module);
                expect(desc.pipeline).toContain('decodebin3');
                // Last-rung escape. decodebin3 auto-plugs BY RANK and would
                // re-plug a struck-off decoder; its error is `ignore`d on this
                // rung, so nothing would break the fail→replug loop. Exactly
                // the demoted decoders, in failure order — the h265 ladder's
                // hardware rung never failed, so it is not masked.
                expect(desc.env?.GST_PLUGIN_FEATURE_RANK).toBe('v4l2h264dec:NONE,avdec_h264:NONE');
                // The note names the BEST rung lost (hardware decode is gone)
                // and is re-applied by the rebuild, so it persists.
                expect((module as any).setHealth).toHaveBeenLastCalledWith(
                    'warning',
                    'Hardware decoder v4l2h264dec failed — using automatic decoder selection',
                );
                expect([...VideoPlayerModule.getDemotedDecoders()].sort()).toEqual([
                    'avdec_h264',
                    'v4l2h264dec',
                ]);
            });

            it('masks nothing on a bootstrap build — decodebin3 picks by rank', () => {
                // With nothing demoted the bin auto-plugs the best decoder the
                // box has, hardware included. Only a decoder that actually
                // failed gets struck out of the auto-plug.
                const module = makeModule();
                expect(build(module).env?.GST_PLUGIN_FEATURE_RANK).toBeUndefined();
            });

            it('leaves the decodebin3 rung alone — today’s error behaviour', () => {
                const module = makeModule();
                build(module); // no codec → decodebin3
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                errorHandlerFor(module)({ message: 'something broke', element: 'decodebin30' });
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                expect(restart).not.toHaveBeenCalled();
            });

            it('never demotes from the fallback card or on a source-side timeout', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h264';
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                const onError = errorHandlerFor(module);

                // Source went away, not the decoder.
                onError({ kind: 'udp_timeout', message: 'UDP source timeout' });
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);

                // Colour bars up: no decoder is running to blame.
                (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(undefined);
                build(module);
                onError({ message: 'surface lost', element: 'waylandsink0' });
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                expect(restart).not.toHaveBeenCalled();
            });

            it('never demotes while an internal restart owns the pipeline', () => {
                // A renderwatch self-heal / cog restack / stall-resume rebuild
                // holds pipelineRestartInProgress for the whole onStop+onStart
                // window, and a pipeline being torn down errors. That is not the
                // decoder's verdict — and the rebuild is already in flight, so
                // there is nothing to trigger either.
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).pipelineRestartInProgress = true;
                errorHandlerFor(module)({ message: 'flushing', element: 'v4l2slh265dec0' });
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                expect(restart).not.toHaveBeenCalled();
            });

            it('a renderwatch lag mid-rebuild coalesces instead of double-restarting', () => {
                // Both onPluginEvent branches funnel through restartPipeline,
                // whose in-progress latch queues ONE follow-up cycle — a codec
                // rebuild and a self-heal can never tear the pipeline down twice.
                const module = makeModule();
                build(module);
                const cycles = vi.fn().mockResolvedValue(undefined);
                (module as any).onStop = cycles;
                (module as any).onStart = cycles;
                // Boot-relative, like the module itself records it.
                (module as any).lastStallResumeAt = bootNowMs();

                const inFlight = (module as any).restartPipeline();
                (module as any).onPluginEvent('renderwatch:lag', {
                    achievedFps: 5,
                    expectedFps: 50,
                    arrivalsFps: 50,
                });
                // The self-heal really did fire (not a vacuous pass).
                expect((module as any).postResumeHealDone).toBe(true);
                return inFlight.then(() => {
                    // 2 cycles = the original + exactly one queued follow-up,
                    // both owned by the ONE in-flight restartPipeline call.
                    expect(cycles).toHaveBeenCalledTimes(4); // 2 cycles × (onStop + onStart)
                    expect((module as any).pipelineRestartInProgress).toBe(false);
                });
            });

            it('rebuilds without demoting when the codec changed after the build', () => {
                // The chain failed because it was steering the WRONG codec's
                // caps, not because the decoder is broken.
                const module = makeModule();
                (module as any).detectedCodec = 'h265';
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                (module as any).onPluginEvent('tsprobe:videoinfo', { codec: 'h264' });
                expect(restart).toHaveBeenCalledTimes(1);

                errorHandlerFor(module)({
                    message: 'Internal data stream error.',
                    element: 'tsdemux0',
                });
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                expect(restart).toHaveBeenCalledTimes(2);
            });

            it('a demotion is engine-session wide — a second instance skips the bad decoder', () => {
                const first = makeModule();
                (first as any).detectedCodec = 'h265';
                build(first);
                vi.spyOn(first as any, 'restartPipeline').mockResolvedValue(undefined);
                errorHandlerFor(first)({
                    message: 'Driver does not support…',
                    element: 'v4l2slh265dec0',
                });

                const second = makeModule();
                (second as any).detectedCodec = 'h265';
                expect(build(second).pipeline).toContain('h265parse ! avdec_h265');
            });

            it('still latches the colour-bars fallback on a bus_stall (unchanged path)', () => {
                const module = makeModule();
                (module as any).detectedCodec = 'h264';
                build(module);
                const restart = vi
                    .spyOn(module as any, 'restartPipeline')
                    .mockResolvedValue(undefined);
                errorHandlerFor(module)({
                    kind: 'bus_stall',
                    message: 'no data',
                    element: 'buswd_5500',
                });
                expect((module as any).busStallDetected).toBe(true);
                expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                expect(restart).toHaveBeenCalledTimes(1);
                (module as any).clearBusStallState();
            });

            describe('demotion is attributable — the 10.9.1.165 regression', () => {
                /** Set up a live h265 pipeline on the hardware rung. */
                function liveOnHardware() {
                    const module = makeModule();
                    (module as any).detectedCodec = 'h265';
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                    const restart = vi
                        .spyOn(module as any, 'restartPipeline')
                        .mockResolvedValue(undefined);
                    return { module, restart, onError: errorHandlerFor(module) };
                }

                it('keeps the hardware decoder when a NON-decoder element errors', () => {
                    // The bug: a compositor/cog flap or a bus rewire during an
                    // engine restart errored the pipeline from the sink, and the
                    // healthy hardware decoder was struck off for the session.
                    const { module, restart, onError } = liveOnHardware();
                    for (const element of [
                        'waylandsink0',
                        'h265parse0',
                        'tsdemux0',
                        'unixfdsrc0',
                        'queue1',
                    ]) {
                        onError({ message: 'transient failure', element });
                    }
                    expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                    // The runner's restartOnError replays the same pipeline —
                    // the module must not tear it down a second time.
                    expect(restart).not.toHaveBeenCalled();
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('never demotes on errors that name NO element, however many', () => {
                    // A bus error with no src name proves nothing about the
                    // decoder, and repeating it doesn't make it proof. The
                    // two-strike rule this replaces stranded a healthy hardware
                    // decoder on software decode for a whole session.
                    const { module, restart, onError } = liveOnHardware();
                    for (let i = 0; i < 5; i++) {
                        onError({ message: 'Internal data stream error' });
                    }
                    expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                    expect(restart).not.toHaveBeenCalled();
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('never demotes on the runner’s SYNTHESISED errors, however many', () => {
                    // A wedged compositor never lets the pipeline reach PLAYING:
                    // the runner's watchdog fires every 10 s and names no
                    // element. It must never cost the decoder its rung.
                    const { module, onError } = liveOnHardware();
                    for (const kind of [
                        'playing_timeout',
                        'playing_timeout',
                        'spawn_failed',
                        'runner_exit',
                        'max_restarts',
                        'playing_timeout',
                    ]) {
                        onError({ kind, message: 'synthesised failure' });
                    }
                    expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('demotes as soon as the DECODER itself errors, first time', () => {
                    // The one rule. No warm-up, no window: the bus named the
                    // decoder, so the decoder loses its rung and the rebuild
                    // drops to software.
                    const { module, restart, onError } = liveOnHardware();
                    onError({
                        message: 'Driver does not support the selected stream',
                        element: 'vpdec',
                    });
                    expect([...VideoPlayerModule.getDemotedDecoders()]).toEqual(['v4l2slh265dec']);
                    expect(restart).toHaveBeenCalledTimes(1);
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');
                });

                it('demotes on the decoder even after a run of unattributable errors', () => {
                    const { module, onError } = liveOnHardware();
                    onError({ message: 'no element here' });
                    onError({ message: 'surface lost', element: 'waylandsink0' });
                    onError({ kind: 'playing_timeout', message: 'no PLAYING' });
                    expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                    // Still on hardware — then the decoder actually speaks up.
                    onError({ message: 'decode failed', element: 'v4l2slh265dec0' });
                    expect([...VideoPlayerModule.getDemotedDecoders()]).toEqual(['v4l2slh265dec']);
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');
                });
            });

            describe('demotion age-out', () => {
                /**
                 * A live h265 pipeline that has just lost hardware decode:
                 * demoted, rebuilt on software, retry armed. The field case —
                 * one corrupt slice used to cost 80% CPU until someone
                 * restarted the engine.
                 */
                function demotedToSoftware() {
                    const module = makeModule();
                    (module as any).detectedCodec = 'h265';
                    build(module);
                    const restart = vi
                        .spyOn(module as any, 'restartPipeline')
                        .mockResolvedValue(undefined);
                    errorHandlerFor(module)({
                        message: 'Driver does not support the selected stream.',
                        element: 'v4l2slh265dec0',
                    });
                    // The rebuild the demotion triggered: lands on software and
                    // arms the retry.
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');
                    return { module, restart };
                }

                beforeEach(() => {
                    // Installed BEFORE any demotion: the timestamps and the
                    // timer must both be on the faked clock or they disagree.
                    vi.useFakeTimers();
                });

                afterEach(() => {
                    vi.useRealTimers();
                    delete process.env[DEMOTION_TTL_ENV_VAR];
                });

                it('stops steering the plan once the demotion is older than the TTL', () => {
                    const { module } = demotedToSoftware();
                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS - 1);
                    expect([...VideoPlayerModule.getDemotedDecoders()]).toEqual(['v4l2slh265dec']);
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');

                    vi.advanceTimersByTime(1);
                    expect(VideoPlayerModule.getDemotedDecoders().size).toBe(0);
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('says when the retry will happen in the demotion log line', () => {
                    const { module } = demotedToSoftware();
                    expect((module as any).log.warn).toHaveBeenCalledWith(
                        expect.objectContaining({
                            decoder: 'v4l2slh265dec',
                            next: 'avdec_h265',
                            retryInMs: DEFAULT_DEMOTION_TTL_MS,
                        }),
                        'Decoder v4l2slh265dec failed — demoted, retrying in 300s, rebuilding on avdec_h265',
                    );
                });

                it('rebuilds to retry the decoder the moment its demotion expires', () => {
                    // Eligibility alone is not enough: a pipeline playing fine
                    // on software has no other reason to rebuild, which is how
                    // the box stayed on the slow path for hours.
                    const { module, restart } = demotedToSoftware();
                    expect(restart).toHaveBeenCalledTimes(1); // the demotion rebuild

                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS - 1);
                    expect(restart).toHaveBeenCalledTimes(1);

                    vi.advanceTimersByTime(1);
                    expect(restart).toHaveBeenCalledTimes(2);
                    expect((module as any).log.info).toHaveBeenCalledWith(
                        {
                            expired: ['v4l2slh265dec'],
                            from: 'avdec_h265',
                            decoder: 'v4l2slh265dec',
                        },
                        'Decoder demotion expired, retrying v4l2slh265dec',
                    );
                    // And the rebuild really does climb back to hardware.
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('re-demotes with a fresh timestamp — the retry cadence is one TTL', () => {
                    const { module, restart } = demotedToSoftware();
                    const onError = errorHandlerFor(module);

                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS);
                    expect(restart).toHaveBeenCalledTimes(2);
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');

                    // The retry fails again immediately: back to software, and
                    // the next attempt is a full TTL out rather than instant.
                    onError({ message: 'Driver does not support…', element: 'v4l2slh265dec0' });
                    expect(restart).toHaveBeenCalledTimes(3);
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');

                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS - 1);
                    expect(restart).toHaveBeenCalledTimes(3);
                    vi.advanceTimersByTime(1);
                    expect(restart).toHaveBeenCalledTimes(4);
                });

                it('re-arms instead of rebuilding when the retry lands early', () => {
                    // A timer that fires a tick before its own deadline must
                    // not rebuild for nothing — and must not spin either.
                    const { module, restart } = demotedToSoftware();
                    const armed = (module as any).demotionRetryTimer;
                    expect(armed).not.toBeNull();

                    (module as any).retryExpiredDemotion();
                    expect(restart).toHaveBeenCalledTimes(1);
                    expect((module as any).demotionRetryTimer).not.toBe(armed);

                    // The real deadline still lands.
                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS);
                    expect(restart).toHaveBeenCalledTimes(2);
                });

                it('drops the retry on stop — it can never fire into a torn-down pipeline', async () => {
                    const { module, restart } = demotedToSoftware();
                    expect((module as any).demotionRetryTimer).not.toBeNull();

                    // The fake child from errorHandlerFor has no stop().
                    (module as any).childProcess = null;
                    await module.onStop();
                    expect((module as any).demotionRetryTimer).toBeNull();

                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS * 3);
                    expect(restart).toHaveBeenCalledTimes(1);
                });

                it('holds the retry while the fallback card is up', () => {
                    // No decoder is running, so there is no degraded rung to
                    // climb off; the next live build arms it again.
                    const { module, restart } = demotedToSoftware();
                    (module as any).services.mediaRouter.getModuleBusSource.mockReturnValue(
                        undefined,
                    );
                    expect(build(module).pipeline).toContain('videotestsrc');
                    expect((module as any).demotionRetryTimer).toBeNull();

                    vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS * 3);
                    expect(restart).toHaveBeenCalledTimes(1);
                });

                it('honours VP_DECODER_DEMOTION_TTL_MS', () => {
                    process.env[DEMOTION_TTL_ENV_VAR] = '60000';
                    const { module, restart } = demotedToSoftware();
                    vi.advanceTimersByTime(59_999);
                    expect(restart).toHaveBeenCalledTimes(1);
                    vi.advanceTimersByTime(1);
                    expect(restart).toHaveBeenCalledTimes(2);
                    expect(build(module).pipeline).toContain('h265parse ! v4l2slh265dec');
                });

                it('keeps the demotion for the session when the age-out is disabled', () => {
                    // The opt-out for a box whose hardware decoder is known
                    // broken: no timer at all, and the plan never changes back.
                    process.env[DEMOTION_TTL_ENV_VAR] = '0';
                    const { module, restart } = demotedToSoftware();
                    expect((module as any).demotionRetryTimer).toBeNull();

                    vi.advanceTimersByTime(86_400_000);
                    expect(restart).toHaveBeenCalledTimes(1);
                    expect([...VideoPlayerModule.getDemotedDecoders()]).toEqual(['v4l2slh265dec']);
                    expect(build(module).pipeline).toContain('h265parse ! avdec_h265');
                });
            });
        });
    });

    describe('updateStatusData', () => {
        it('reports the input source as the bus channel port', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: {
                    getModuleBusSource: vi.fn(() => ({
                        port: 5500,
                        socketPath: '/tmp/mr-bus-5500-abc.sock',
                    })),
                },
            };
            const setStatusData = vi.fn();
            (module as any).setStatusData = setStatusData;
            (module as any).updateStatusData();
            expect(setStatusData).toHaveBeenCalledWith('input', {
                source: 'bus 5500',
                state: 'connected',
            });
        });

        it('reports a dash when no source is connected', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleBusSource: vi.fn(() => undefined) },
            };
            const setStatusData = vi.fn();
            (module as any).setStatusData = setStatusData;
            (module as any).updateStatusData();
            expect(setStatusData).toHaveBeenCalledWith('input', {
                source: '—',
                state: 'no source',
            });
        });
    });

    describe('onLiveConfigUpdate', () => {
        function makeRunningModule(opts: {
            hasSource: boolean;
            /** Engine-wide time-sync contract (ADR-0005). Off ⇒ legacy path. */
            timeSyncContract?: boolean;
            /** Engine-wide default playout offset D. */
            playoutOffsetMs?: number;
            /** Override declared by the route head feeding this player. */
            routeOffsetMs?: number;
        }) {
            const module = new VideoPlayerModule();
            const setProperty = vi.fn().mockResolvedValue(undefined);
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: {
                    getModuleBusSource: vi.fn(() =>
                        opts.hasSource
                            ? { port: 5500, socketPath: '/tmp/mr-bus-5500-abc.sock' }
                            : undefined,
                    ),
                    getRoutePlayoutOffsetMs: vi.fn(() => opts.routeOffsetMs),
                },
                ...(opts.timeSyncContract ? { timeSyncContract: true } : {}),
                ...(opts.playoutOffsetMs !== undefined
                    ? { playoutOffsetMs: opts.playoutOffsetMs }
                    : {}),
            };
            (module as any).config = { fallbackText: 'old', display: '' };
            // Pretend a child process is running and reachable.
            (module as any).childProcess = { isRunning: true, setProperty };
            return { module, setProperty };
        }

        it('updates the nov text overlay only when the fallback pipeline is running', async () => {
            // The fallback pipeline is what owns `nov`. When no source is
            // connected the live update is safe and should reach the runner.
            const { module, setProperty } = makeRunningModule({ hasSource: false });
            await module.onLiveConfigUpdate({ fallbackText: 'New text' });
            expect(setProperty).toHaveBeenCalledWith('nov', 'text', 'New text');
        });

        it('skips the nov update when the live pipeline is running', async () => {
            // Regression: previously this fired `setProperty('nov', ...)`
            // unconditionally, which the Python runner reported as
            // `Element not found: nov`. The gst-runner's `restartOnError`
            // treats any error event as a fatal bus error and tears the
            // live pipeline down — that was the visible "crash on Save"
            // when the user changed an unrelated field with a source
            // connected.
            const { module, setProperty } = makeRunningModule({ hasSource: true });
            await module.onLiveConfigUpdate({ fallbackText: 'New text' });
            expect(setProperty).not.toHaveBeenCalled();
        });

        it('updates the nov text overlay when source is silent (stall fallback active)', async () => {
            // Reported bug: user typed in the live-updatable "Fallback Text"
            // field while the source was down (colour bars showing) and the
            // overlay didn't refresh. The fallback pipeline owns `nov` in
            // *both* "no source" and "source-silent" states; the guard now
            // pushes the live update in either case.
            const { module, setProperty } = makeRunningModule({ hasSource: true });
            (module as any).busStallDetected = true;
            await module.onLiveConfigUpdate({ fallbackText: 'Whats sup' });
            expect(setProperty).toHaveBeenCalledWith('nov', 'text', 'Whats sup');
        });

        /**
         * Playout offset D on the video leg (ADR-0005 decision 4). The
         * `lipSyncMs` live push predates D and must keep working — but under
         * the contract what goes on the wire is the WHOLE offset (D + trim),
         * not the raw trim, or a lip-sync nudge would silently throw the route
         * offset away.
         */
        describe('playout offset', () => {
            it('pushes the bare lipSyncMs trim with the contract off', async () => {
                const { module, setProperty } = makeRunningModule({ hasSource: true });
                await module.onLiveConfigUpdate({ lipSyncMs: 40 });
                expect(setProperty).toHaveBeenCalledWith('sink', 'ts-offset', 40_000_000);
            });

            it('pushes D + trim with the contract on, not the trim alone', async () => {
                const { module, setProperty } = makeRunningModule({
                    hasSource: true,
                    timeSyncContract: true,
                    playoutOffsetMs: 300,
                    routeOffsetMs: 500,
                });
                await module.onLiveConfigUpdate({ lipSyncMs: 40 });
                expect(setProperty).toHaveBeenCalledWith('sink', 'ts-offset', 540_000_000);
            });

            it('re-pushes when the route head moves D, with no config change at all', async () => {
                const { module, setProperty } = makeRunningModule({
                    hasSource: true,
                    timeSyncContract: true,
                    playoutOffsetMs: 300,
                    routeOffsetMs: 500,
                });
                await module.onRoutePlayoutOffsetChanged();
                expect(setProperty).toHaveBeenCalledWith('sink', 'ts-offset', 500_000_000);
            });
        });
    });
});

describe('renderWatch health messages', () => {
    function makeModule() {
        const module = new VideoPlayerModule();
        (module as any).setHealth = vi.fn();
        return module;
    }

    it('render lag (presented below arrivals) → lower-resolution advice', () => {
        const module = makeModule();
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 41,
            expectedFps: 50,
            arrivalsFps: 50,
        });
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            "Video output can't keep up (41/50 fps) — lower the stream or display resolution",
        );
    });

    it('source shortfall (presented ≈ arrivals) → check-the-link advice, not resolution advice', () => {
        // Field case 2026-08-01: RIST link dips deliver only ~41 fps; the sink
        // presents every frame that arrives (dropped=0). Blaming the render
        // chain would send the operator to the wrong knob.
        const module = makeModule();
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 41,
            expectedFps: 50,
            arrivalsFps: 41.5,
        });
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            'Stream under-delivering (41/50 fps) — check the source/link (display is keeping up)',
        );
    });

    it('missing arrivalsFps (older runner) falls back to the render-lag message', () => {
        const module = makeModule();
        (module as any).onPluginEvent('renderwatch:lag', { achievedFps: 41, expectedFps: 50 });
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining("can't keep up"),
        );
    });

    it('render lag shortly after a stall-resume triggers ONE self-heal rebuild', () => {
        // Field case 2026-08-02: live pipeline rebuilt against a just-recovered,
        // still-churning source ran degraded (green band + steady late-drops)
        // until a manual restart. One free rebuild per resume fixes that; a
        // second lag is a real render problem and stays visible.
        const module = makeModule();
        const restart = vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
        (module as any).log = { info: vi.fn(), warn: vi.fn() };
        // Boot-relative clock on both sides — see SelfHealInput.now.
        (module as any).lastStallResumeAt = bootNowMs() - 10_000;
        const lag = { achievedFps: 44, expectedFps: 50, arrivalsFps: 49 };
        (module as any).onPluginEvent('renderwatch:lag', lag);
        expect(restart).toHaveBeenCalledTimes(1);
        (module as any).onPluginEvent('renderwatch:lag', lag);
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it('no self-heal outside the post-resume window or for source shortfall', () => {
        const module = makeModule();
        const restart = vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
        (module as any).log = { info: vi.fn(), warn: vi.fn() };
        // Old resume: outside the heal window.
        (module as any).lastStallResumeAt = bootNowMs() - 600_000;
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 44,
            expectedFps: 50,
            arrivalsFps: 49,
        });
        expect(restart).not.toHaveBeenCalled();
        // Recent resume but the SOURCE is under-delivering — a rebuild can't
        // manufacture frames the stream never carried.
        (module as any).lastStallResumeAt = bootNowMs() - 10_000;
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 41,
            expectedFps: 50,
            arrivalsFps: 41,
        });
        expect(restart).not.toHaveBeenCalled();
    });

    it('recovered clears only a warning this module raised', () => {
        const module = makeModule();
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 41,
            expectedFps: 50,
            arrivalsFps: 50,
        });
        (module as any).health = 'warning';
        (module as any).onPluginEvent('renderwatch:recovered', {});
        expect((module as any).setHealth).toHaveBeenLastCalledWith('ok');
    });

    it('total stall with the bus still flowing blames the pipeline, not the source', () => {
        // Field case: 0/50 fps for minutes while the source was healthy. The
        // old `achieved >= arrivals - 1` guard is trivially true at 0/0 and
        // sent the operator to check a link that was fine.
        const module = makeModule();
        (module as any).busStallDetected = false;
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 0,
            expectedFps: 50,
            arrivalsFps: 0,
        });
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            'Video output stalled (0/50 fps) — the source is still delivering, the decode/display chain has stopped',
        );
    });

    it('total stall while the bus-stall latch is set stays attributed to the source', () => {
        const module = makeModule();
        (module as any).busStallDetected = true;
        (module as any).onPluginEvent('renderwatch:lag', {
            achievedFps: 0,
            expectedFps: 50,
            arrivalsFps: 0,
        });
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            'No video arriving (0/50 fps) — the source has stopped delivering',
        );
    });
});

describe('renderWatch journal trail (health transitions)', () => {
    // Field finding: renderwatch fps data lived only in module state, so a
    // total render stall left NO journal line — log-based fleet monitoring
    // could not see minutes of black screen. Transitions only: a warning per
    // window would drown the journal in exactly the repeats it must not spam.
    function makeModule() {
        const module = new VideoPlayerModule() as any;
        module.setHealth = vi.fn();
        module.log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
        return module;
    }

    const stall = { achievedFps: 0, expectedFps: 50, arrivalsFps: 0, droppedFps: 0 };

    it('logs the ok→warning edge with the fps figures and the attributed reason', () => {
        const module = makeModule();
        module.onPluginEvent('renderwatch:lag', stall);
        expect(module.log.warn).toHaveBeenCalledTimes(1);
        const [fields, message] = module.log.warn.mock.calls[0];
        expect(fields.renderWatch).toEqual(stall);
        expect(fields.kind).toBe('total-stall');
        expect(message).toContain('Render keep-up degraded');
        expect(message).toContain('0/50 fps');
    });

    it('does not repeat the line while the same episode continues', () => {
        const module = makeModule();
        module.onPluginEvent('renderwatch:lag', stall);
        module.onPluginEvent('renderwatch:lag', stall);
        module.onPluginEvent('renderwatch:lag', stall);
        expect(module.log.warn).toHaveBeenCalledTimes(1);
    });

    it('logs the warning→ok edge on recovery, and only when a lag was latched', () => {
        const module = makeModule();
        // Recovery with no lag outstanding (fresh pipeline) says nothing.
        module.onPluginEvent('renderwatch:recovered', { achievedFps: 50, expectedFps: 50 });
        expect(module.log.info).not.toHaveBeenCalled();

        module.onPluginEvent('renderwatch:lag', stall);
        module.onPluginEvent('renderwatch:recovered', { achievedFps: 50, expectedFps: 50 });
        expect(module.log.info).toHaveBeenCalledWith(
            { renderWatch: { achievedFps: 50, expectedFps: 50 } },
            'Render keep-up recovered',
        );
    });

    it('a second episode after recovery logs again (both edges are real)', () => {
        const module = makeModule();
        module.onPluginEvent('renderwatch:lag', stall);
        module.onPluginEvent('renderwatch:recovered', {});
        module.onPluginEvent('renderwatch:lag', stall);
        expect(module.log.warn).toHaveBeenCalledTimes(2);
    });

    // Measured on target (Pi 400, weston SIGSTOP 150 s, chain live, 0 fps):
    // the runner's renderWatch reporter ticks on RENDERS, so a hard stall stops
    // the event stream itself — one line at onset, then nothing until recovery.
    // The event-driven re-emit cannot cover that; the timer below does.
    describe('silent-chain re-emit (no events arriving at all)', () => {
        it('arms one interval for the episode, however many events arrive', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            const timer = module.renderLagSilentTimer;
            expect(timer).not.toBeNull();
            module.onPluginEvent('renderwatch:lag', stall);
            module.onPluginEvent('renderwatch:lag', stall);
            expect(module.renderLagSilentTimer).toBe(timer);
            module.clearRenderLagState();
        });

        it('re-states the episode with the last figures and a silence marker', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            // Pin the episode's clock: the edge warned and the last event
            // arrived at t=1000, and nothing has arrived since.
            module.renderLagEventAt = 1_000;
            module.renderLagWarnedAt = 1_000;
            module.log.warn.mockClear();

            module.pollRenderLagSilence(() => 1_000 + 30_000); // not due yet
            expect(module.log.warn).not.toHaveBeenCalled();

            module.pollRenderLagSilence(() => 1_000 + 60_000);
            expect(module.log.warn).toHaveBeenCalledTimes(1);
            const [fields, message] = module.log.warn.mock.calls[0];
            // The figures the runner managed to send before it went quiet.
            expect(fields.renderWatch).toEqual(stall);
            expect(fields.kind).toBe('total-stall');
            expect(fields.eventsSilentMs).toBe(60_000);
            expect(message).toContain('Render keep-up degraded');
            expect(message).toContain('0/50 fps');
            expect(message).toContain('no renderWatch update for 60s');
            module.clearRenderLagState();
        });

        it('re-emits on the 60 s cadence for as long as the silence lasts', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            // The edge warned at t0 and the last event arrived with it.
            const t0 = 1_000;
            module.renderLagEventAt = t0;
            module.renderLagWarnedAt = t0;
            module.log.warn.mockClear();
            // 150 s of silence, ticking every RENDER_LAG_SILENT_TICK_MS.
            for (let t = 15_000; t <= 150_000; t += 15_000) {
                module.pollRenderLagSilence(() => t0 + t);
            }
            expect(module.log.warn).toHaveBeenCalledTimes(2); // 60 s and 120 s
            module.clearRenderLagState();
        });

        it('does not double-log while the event stream is still flowing', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            module.log.warn.mockClear();
            // An event 2 s ago and a warning a minute ago: the event path owns
            // this line, the timer must stay out of it.
            module.renderLagEventAt = 118_000;
            module.renderLagWarnedAt = 60_000;
            module.pollRenderLagSilence(() => 120_000);
            expect(module.log.warn).not.toHaveBeenCalled();
            module.clearRenderLagState();
        });

        it('a tick after recovery says nothing — the latch is the gate', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            module.onPluginEvent('renderwatch:recovered', {});
            expect(module.renderLagSilentTimer).toBeNull();
            module.log.warn.mockClear();
            module.pollRenderLagSilence(() => 10_000_000);
            expect(module.log.warn).not.toHaveBeenCalled();
        });

        it('recovery drops the timer and the episode state', () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            module.onPluginEvent('renderwatch:recovered', {});
            expect(module.renderLagSilentTimer).toBeNull();
            expect(module.renderLagActive).toBe(false);
            expect(module.renderLagWarnedAt).toBe(0);
            expect(module.renderLagEventAt).toBe(0);
            expect(module.renderLagLast).toBeNull();
        });

        it('onStop mid-episode leaks nothing', async () => {
            const module = makeModule();
            module.onPluginEvent('renderwatch:lag', stall);
            expect(module.renderLagSilentTimer).not.toBeNull();
            await module.onStop();
            expect(module.renderLagSilentTimer).toBeNull();
            expect(module.renderLagActive).toBe(false);
            expect(module.renderLagLast).toBeNull();
        });
    });
});

describe('cog restack rule (start-time comparison)', () => {
    function makeModule() {
        const module = new VideoPlayerModule() as any;
        module.log = { info: vi.fn() };
        module.cogWatchStartedAt = 1000_000;
        module.currentActiveDisplayName = () => 'HDMI-A-1';
        module.restartPipeline = vi.fn().mockResolvedValue(undefined);
        return module;
    }

    it('cog started after our pipeline → one restack restart, latched per PID', () => {
        // Field case 2026-08-02 (monitor power-cycle): compositor restart
        // respawned cog AFTER the video pipeline rebuilt; the old PID-baseline
        // watch captured the new cog as baseline and never restacked — video
        // stayed hidden behind the control panel indefinitely.
        const module = makeModule();
        const find = () => 500;
        const start = () => 1000_500; // cog newer than pipeline
        module.pollCogRestack(find, start);
        expect(module.restartPipeline).toHaveBeenCalledTimes(1);
        module.pollCogRestack(find, start); // same cog PID → latched
        expect(module.restartPipeline).toHaveBeenCalledTimes(1);
    });

    it('cog well older than our pipeline → no restart (we are already on top)', () => {
        const module = makeModule();
        module.pollCogRestack(
            () => 500,
            () => 900_000, // 100 s before the watch — far outside the grace window
        );
        expect(module.restartPipeline).not.toHaveBeenCalled();
    });

    it('cog slightly older than our pipeline (surface-grace window) → restack once', () => {
        // A cog process can predate the pipeline while its page (and thus its
        // surface) renders after ours — field test 2026-08-02: weston restart
        // spawned cog ~2 s before the pipeline rebuilt and the exact rule
        // stayed quiet with the stacking unknown.
        const module = makeModule();
        module.pollCogRestack(
            () => 500,
            () => 995_000, // 5 s before the watch — inside the 15 s grace
        );
        expect(module.restartPipeline).toHaveBeenCalledTimes(1);
        module.pollCogRestack(
            () => 500,
            () => 995_000,
        );
        expect(module.restartPipeline).toHaveBeenCalledTimes(1); // latched
    });

    it('the restack latch survives a watch stop/start cycle (no grace-window loop)', () => {
        const module = makeModule();
        module.pollCogRestack(
            () => 500,
            () => 995_000,
        );
        expect(module.restartPipeline).toHaveBeenCalledTimes(1);
        module.stopCogPollWatch();
        module.cogWatchStartedAt = 1_000_500; // watch re-armed after the rebuild
        module.pollCogRestack(
            () => 500,
            () => 995_000,
        );
        expect(module.restartPipeline).toHaveBeenCalledTimes(1); // still latched
    });

    it('cog absent or start time unreadable → wait, no restart', () => {
        const module = makeModule();
        module.pollCogRestack(
            () => undefined,
            () => 1000_500,
        );
        module.pollCogRestack(
            () => 500,
            () => undefined,
        );
        expect(module.restartPipeline).not.toHaveBeenCalled();
    });

    it('a NEW cog incarnation after a latched one restarts again', () => {
        const module = makeModule();
        module.pollCogRestack(
            () => 500,
            () => 1000_500,
        );
        module.pollCogRestack(
            () => 501,
            () => 1000_900,
        );
        expect(module.restartPipeline).toHaveBeenCalledTimes(2);
    });
});

describe('stale renderwatch warning cleared on rebuild', () => {
    it('onStop clears a lag-owned warning so it cannot outlive the pipeline', async () => {
        // Field case 2026-08-02: "(0/50 fps)" latched while the compositor
        // was down; the rebuilt pipeline's fresh monitor starts un-lagged and
        // only reports transitions, so the warning stuck forever.
        const module = new VideoPlayerModule() as any;
        module.setHealth = vi.fn();
        module.renderLagActive = true;
        module.health = 'warning';
        await module.onStop();
        expect(module.setHealth).toHaveBeenCalledWith('ok');
        expect(module.renderLagActive).toBe(false);
    });

    it('onStop leaves health alone when the warning is not lag-owned', async () => {
        const module = new VideoPlayerModule() as any;
        module.setHealth = vi.fn();
        module.renderLagActive = false;
        module.health = 'warning'; // someone else's warning
        await module.onStop();
        expect(module.setHealth).not.toHaveBeenCalledWith('ok');
    });
});

describe('kernel hardware-decode latch', () => {
    // The driver disables the HEVC block on its first wedge and then fails
    // every job with VB2_BUF_STATE_ERROR — which v4l2codecs ignores, so the
    // pipeline renders a frozen picture and nothing errors. The kernel line is
    // the only notification there is; these tests cover what the plugin does
    // with it. See helpers/decoderDemotions.ts for the permanence itself.
    const onKernelLogSignalMock = onKernelLogSignal as unknown as ReturnType<typeof vi.fn>;
    const busSource = {
        port: 5500,
        socketPath: '/tmp/mr-bus-5500-abc.sock',
        sourceModuleId: 'ts-input-1',
        sourcePortId: 'mpegts-out',
    };
    const all = Object.fromEntries(DECODER_ELEMENTS.map((e) => [e, true]));
    const LATCH_EVENT: KernelLogSignalEvent = {
        signal: 'hevc-decode-disabled',
        source: 'kmsg',
        line: 'rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot',
    };
    let prevWaylandDisplay: string | undefined;

    beforeEach(() => {
        prevWaylandDisplay = process.env.WAYLAND_DISPLAY;
        VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
        VideoPlayerModule.setDecoderAvailability(all);
        VideoPlayerModule._test_startedInstances().clear();
        onKernelLogSignalMock.mockClear();
        (listDrmConnectors as unknown as ReturnType<typeof vi.fn>).mockReturnValue([]);
        (firstConnectedDisplay as unknown as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    });

    afterEach(() => {
        VideoPlayerModule._test_startedInstances().clear();
        VideoPlayerModule._test_resetDecoderState();
        vi.useRealTimers();
        // registerServices runs ensureWaylandEnv, which may adopt a compositor
        // socket belonging to the machine the tests run on.
        if (prevWaylandDisplay !== undefined) process.env.WAYLAND_DISPLAY = prevWaylandDisplay;
        else delete process.env.WAYLAND_DISPLAY;
    });

    /** Run the real registration and hand back the handler it subscribed. */
    function subscribeHandler(): (event: KernelLogSignalEvent) => void {
        VideoPlayerModule.registerServices({
            deviceProviders: { register: vi.fn() },
        } as never);
        const call = onKernelLogSignalMock.mock.calls.at(-1)!;
        expect(call[0]).toBe('hevc-decode-disabled');
        return call[1] as (event: KernelLogSignalEvent) => void;
    }

    function makeStartedModule() {
        const module = new VideoPlayerModule();
        (module as any).services = {
            instanceId: 'video-player-1',
            mediaRouter: { getModuleBusSource: vi.fn(() => busSource) },
        };
        (module as any).setHealth = vi.fn();
        (module as any).log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        (module as any).config = { display: '' };
        VideoPlayerModule._test_startedInstances().add(module);
        const restart = vi.spyOn(module as any, 'restartPipeline').mockResolvedValue(undefined);
        return { module, restart };
    }

    it('subscribes to the kernel signal once at plugin load', () => {
        subscribeHandler();
        expect(onKernelLogSignalMock).toHaveBeenCalledTimes(1);
        expect(onKernelLogSignalMock.mock.calls[0][0]).toBe('hevc-decode-disabled');
    });

    it('demotes every hardware decoder permanently and rebuilds each started player', () => {
        const handler = subscribeHandler();
        const a = makeStartedModule();
        const b = makeStartedModule();

        handler(LATCH_EVENT);

        expect([...VideoPlayerModule._test_permanentDemotions()].sort()).toEqual(
            [...HARDWARE_DECODER_IDS].sort(),
        );
        expect([...VideoPlayerModule.getDemotedDecoders()].sort()).toEqual(
            [...HARDWARE_DECODER_IDS].sort(),
        );
        for (const inst of [a, b]) {
            expect((inst.module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                KERNEL_HW_DECODE_DISABLED_NOTE,
            );
            // The wedged pipeline will never rebuild itself — nothing errors.
            expect(inst.restart).toHaveBeenCalledTimes(1);
            expect((inst.module as any).log.error).toHaveBeenCalled();
        }
    });

    it('leaves a stopped player alone', () => {
        const handler = subscribeHandler();
        const { module, restart } = makeStartedModule();
        VideoPlayerModule._test_startedInstances().delete(module);

        handler(LATCH_EVENT);

        expect(restart).not.toHaveBeenCalled();
        // The demotion is process-wide even so: the instance's next start must
        // not open a decoder the kernel has switched off.
        expect(VideoPlayerModule.getDemotedDecoders().has('v4l2slh265dec')).toBe(true);
    });

    it('is idempotent — the kernel line may be repeated or replayed', () => {
        const handler = subscribeHandler();
        const { module, restart } = makeStartedModule();

        handler(LATCH_EVENT);
        handler(LATCH_EVENT);

        expect(restart).toHaveBeenCalledTimes(2); // one rebuild per delivery
        expect([...VideoPlayerModule._test_permanentDemotions()].sort()).toEqual(
            [...HARDWARE_DECODER_IDS].sort(),
        );
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            KERNEL_HW_DECODE_DISABLED_NOTE,
        );
    });

    it('builds the h265 pipeline on software and says why', () => {
        const handler = subscribeHandler();
        const { module } = makeStartedModule();
        (module as any).detectedCodec = 'h265';

        handler(LATCH_EVENT);
        const desc = module.buildPipeline((module as any).config)!;

        expect(desc.pipeline).toContain('h265parse ! avdec_h265');
        expect(desc.pipeline).not.toContain('v4l2slh265dec');
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            `${KERNEL_HW_DECODE_DISABLED_NOTE} (avdec_h265)`,
        );
    });

    it('arms no demotion retry — the TTL cannot bring the decoder back', () => {
        vi.useFakeTimers();
        const handler = subscribeHandler();
        const { module, restart } = makeStartedModule();
        (module as any).detectedCodec = 'h265';

        handler(LATCH_EVENT);
        restart.mockClear();
        module.buildPipeline((module as any).config);

        // A TTL demotion here would have re-armed a rebuild every 5 minutes,
        // each one landing straight back on the dead decoder.
        vi.advanceTimersByTime(DEFAULT_DEMOTION_TTL_MS * 3);
        expect(restart).not.toHaveBeenCalled();
        expect((module as any).demotionRetryTimer).toBeNull();
    });
});

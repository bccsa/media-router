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

import { firstConnectedDisplay, listDrmConnectors, probeUnixSocket } from '@media-router/engine';
import { VideoPlayerModule } from './VideoPlayerModule.js';
import { currentWaylandSessionIdent, findCogPidForDisplay } from './helpers/wayland.js';
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

const probeUnixSocketMock = probeUnixSocket as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

describe('VideoPlayerModule helpers', () => {
    beforeEach(() => {
        // Reset any cached probe state so each test sets its own.
        VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
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
            expect(
                buildSink('HDMI-A-1', { ...both, waylandSession: false, connectorId: 32 }),
            ).toBe('kmssink name=sink connector-id=32 sync=false qos=true');
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
            expect(
                buildSink('', { wayland: false, kms: false, waylandSession: false }),
            ).toBe('autovideosink sync=false qos=true');
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
                expect(
                    buildSink('', { ...both, waylandSession: true }, { sync: true }),
                ).toBe(
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
                ).toBe('kmssink name=sink connector-id=32 sync=true max-lateness=1000000000 qos=true');
            });
            it('emits sync=true max-lateness=1000000000 on auto-pick kmssink', () => {
                expect(
                    buildSink('', { ...both, waylandSession: false }, { sync: true }),
                ).toBe('kmssink name=sink sync=true max-lateness=1000000000 qos=true');
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
                    buildSink(
                        '',
                        { ...both, waylandSession: true },
                        { sync: true, qos: false },
                    ),
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
        it('opts into multi-core (frame) decode only for the explicit "frame" value', () => {
            expect(resolveDecoderThreadType('frame')).toBe('frame');
        });

        it('defaults to latency-safe "auto" when unset', () => {
            expect(resolveDecoderThreadType(undefined)).toBe('auto');
        });

        it('falls back to "auto" for "auto" and any unrecognised / junk value', () => {
            expect(resolveDecoderThreadType('auto')).toBe('auto');
            expect(resolveDecoderThreadType('slice')).toBe('auto');
            expect(resolveDecoderThreadType('')).toBe('auto');
            expect(resolveDecoderThreadType(1)).toBe('auto');
            expect(resolveDecoderThreadType(null)).toBe('auto');
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

        it('clock-locked mode (preserveSourcePts=true) uses the same tsparse-free input — the source timeline comes from tsdemux PES via preserveSourceTimeline', () => {
            const s = buildLivePipeline(
                'kmssink name=sink sync=true max-lateness=1000000000 qos=true',
                busSource,
                false,
                200,
                true,
            );
            expect(s).not.toContain('tsparse');
            expect(s).toContain('tsdemux');
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
            const firstConnectedDisplayMock =
                firstConnectedDisplay as unknown as ReturnType<typeof vi.fn>;

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
            // a prgname into process listings would just be confusing.
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
            fakeProc(123, '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2');
            expect(findCogPidForDisplay('', tmp)).toBeUndefined();
        });

        it('returns the PID of the cog instance pinned to the given connector', () => {
            fakeProc(101, '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2');
            fakeProc(202, '/usr/bin/cog http://localhost:8083/background --gapplication-app-id=local.cog.HDMI-A-1');
            expect(findCogPidForDisplay('HDMI-A-1', tmp)).toBe(202);
            expect(findCogPidForDisplay('DSI-2', tmp)).toBe(101);
        });

        it('returns undefined when no cog is running for the requested display', () => {
            fakeProc(101, '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2');
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
            fakeProc(404, '/usr/bin/cog http://localhost:8081 --gapplication-app-id=local.cog.DSI-2');
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
            const restart = vi
                .spyOn(module as any, 'restartPipeline')
                .mockResolvedValue(undefined);
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
            expect(desc.pipeline).toContain(
                `unixfdsrc socket-path=${busSource.socketPath}`,
            );
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

                // Counter advanced: source resumed → back to live.
                readBytes.mockResolvedValue(2000);
                await (module as any).pollBusResume();
                expect((module as any).busStallDetected).toBe(false);
                expect(restart).toHaveBeenCalledTimes(1);
                expect((module as any).busResumeWatchdog).toBeNull();
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

                // Producer respawned — socket answers → retry live directly.
                probeUnixSocketMock.mockResolvedValue(true);
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
        function makeRunningModule(opts: { hasSource: boolean }) {
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
                },
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
    });
});

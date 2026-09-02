import { describe, it, expect, vi, beforeEach } from 'vitest';

// `initManifest` now delegates the element probing to the engine's shared
// `ProbedEncoders.probe` (which calls `probeGstElement` internally, not through
// this barrel). Stub the static to control availability; the real
// `applyToManifest`, `buildEncoderBranch` and `resolveImpl` behaviour comes
// through from `...actual`. The element-probing logic itself is covered by
// packages/engine/src/plugins/encoderManifest.test.ts and probedEncoders.test.ts.
// The v4l2 demand gate itself is covered by
// packages/engine/src/system/v4l2DeviceProvider.test.ts; mocked here so this
// file can pin the LIFECYCLE wiring — which hook claims and releases it.
vi.mock('@media-router/engine', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@media-router/engine');
    return {
        ...actual,
        registerV4l2DeviceProvider: vi.fn(),
        acquireV4l2Demand: vi.fn(),
        releaseV4l2Demand: vi.fn(),
    };
});

import * as engine from '@media-router/engine';
import { buildEncoderBranch, resolveImpl, ProbedEncoders } from '@media-router/engine';
import { bitrateBadge } from '@media-router/engine';
import type { CodecId, ImplId } from '@media-router/engine';
import { VideoEncoderModule } from './VideoEncoderModule.js';
import { parseResolution } from '@media-router/engine';
import { buildV4l2Source, supportsLiveBitrate } from './videoEncoderPipeline.js';

function setAvailability(availability: Partial<Record<CodecId, ImplId[]>>) {
    vi.spyOn(ProbedEncoders, 'probe').mockResolvedValue(ProbedEncoders.forTest(availability));
}

describe('VideoEncoderModule', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        // Reset the static availability between tests so stale state from
        // one test's initManifest doesn't leak into another.
        VideoEncoderModule.setAvailableImpls({ h264: [], h265: [], av1: [] });
    });

    describe('initManifest', () => {
        it('narrows codec enum to installed encoders and populates encoderImpl x-enumBy', async () => {
            setAvailability({ h264: ['v4l2', 'software'], h265: ['software'], av1: [] });
            const manifest: Record<string, any> = {
                configSchema: {
                    properties: {
                        codec: { enum: ['h264', 'h265', 'av1'] },
                        encoderImpl: { enum: ['auto', 'v4l2', 'va', 'software'] },
                    },
                },
            };
            await VideoEncoderModule.initManifest(manifest);
            expect(manifest.configSchema.properties.codec.enum).toEqual(['h264', 'h265']);
            expect(manifest.configSchema.properties.encoderImpl['x-enumBy']).toEqual({
                field: 'codec',
                map: {
                    h264: ['auto', 'v4l2', 'software'],
                    h265: ['auto', 'software'],
                    av1: ['auto'],
                },
            });
            // Runtime availability is seeded so resolveImpl picks an installed impl.
            expect(VideoEncoderModule.getAvailableImpls()).toEqual({
                h264: ['v4l2', 'software'],
                h265: ['software'],
                av1: [],
            });
        });

        it('leaves enum untouched when no encoders are installed', async () => {
            setAvailability({ h264: [], h265: [], av1: [] });
            const manifest: Record<string, any> = {
                configSchema: {
                    properties: {
                        codec: { enum: ['h264'] },
                        encoderImpl: { enum: ['auto', 'v4l2', 'va', 'software'] },
                    },
                },
            };
            await VideoEncoderModule.initManifest(manifest);
            expect(manifest.configSchema.properties.codec.enum).toEqual(['h264']);
            expect(VideoEncoderModule.getAvailableImpls()).toEqual({
                h264: [],
                h265: [],
                av1: [],
            });
        });
    });

    describe('resolveImpl', () => {
        it('prefers v4l2 when auto and v4l2 is in the available list', () => {
            expect(resolveImpl('h264', 'auto', ['v4l2', 'software'])).toBe('v4l2');
        });
        it('falls back to software when auto and v4l2 is not available', () => {
            expect(resolveImpl('h264', 'auto', ['software'])).toBe('software');
        });
        it('returns null when nothing is available', () => {
            expect(resolveImpl('h264', 'auto', [])).toBeNull();
        });
        it('falls back when the user forced an impl that is not available', () => {
            expect(resolveImpl('h264', 'v4l2', ['software'])).toBe('software');
        });
        it('honours an explicit software preference when available', () => {
            expect(resolveImpl('h264', 'software', ['v4l2', 'software'])).toBe('software');
        });
    });

    describe('buildEncoderBranch', () => {
        // Video Encoder passes name 'venc0' + speed-preset 'superfast'; the other
        // knobs stay at the shared builder's defaults (CBR for software, auto
        // profile, scenecut 40 — x264's own default, so it's behaviourally
        // neutral). The v4l2 branch pins VBR regardless — see
        // buildV4l2ExtraControls (CBR stalls the bcm2835 encoder live).
        const branch = (
            codec: 'h264' | 'h265' | 'av1',
            impl: 'v4l2' | 'software',
            bitrateKbps: number,
            kif: number,
        ) =>
            buildEncoderBranch({
                codec,
                impl,
                bitrateKbps,
                kif,
                name: 'venc0',
                speedPreset: 'superfast',
            });

        it('builds H.264 V4L2 pinned to VBR (video_bitrate_mode=0) with bitrate and both keyframe-period controls', () => {
            const s = branch('h264', 'v4l2', 4000, 60);
            expect(s).toContain('v4l2h264enc name=venc0');
            expect(s).toContain('video_bitrate=4000000');
            // VBR is load-bearing: video_bitrate_mode=1 throttles the bcm2835
            // encoder to ~10 fps on live input (see buildV4l2ExtraControls).
            expect(s).toContain('video_bitrate_mode=0');
            expect(s).not.toContain('video_bitrate_mode=1');
            expect(s).toContain('repeat_sequence_header=1');
            expect(s).toContain('video_gop_size=60');
            expect(s).toContain('h264_i_frame_period=60');
            expect(s).toContain('h264parse');
        });
        it('builds H.265 V4L2 pinned to VBR with the H.265 keyframe-period control', () => {
            const s = branch('h265', 'v4l2', 5000, 90);
            expect(s).toContain('v4l2h265enc name=venc0');
            expect(s).toContain('video_bitrate=5000000');
            expect(s).toContain('video_bitrate_mode=0');
            expect(s).toContain('h265_i_frame_period=90');
            expect(s).toContain('h265parse');
        });
        it('builds H.264 software as CBR (peak capped at target, nal-hrd=cbr) with superfast preset and x264-default scenecut', () => {
            const s = branch('h264', 'software', 3500, 90);
            expect(s).toContain('x264enc name=venc0');
            expect(s).toContain('speed-preset=superfast');
            expect(s).toContain('bitrate=3500');
            expect(s).toContain('key-int-max=90');
            // scenecut=40 is x264's own default → behaviourally neutral, now
            // spelled out because the shared builder always emits it.
            expect(s).toContain(
                'option-string="nal-hrd=cbr:vbv-maxrate=3500:vbv-bufsize=3500:scenecut=40"',
            );
            expect(s).toContain('h264parse');
        });
        it('builds H.265 software as CBR (strict-cbr, peak capped at target)', () => {
            const s = branch('h265', 'software', 3000, 30);
            expect(s).toContain('x265enc name=venc0');
            expect(s).toContain('speed-preset=superfast');
            expect(s).toContain('bitrate=3000');
            expect(s).toContain(
                'option-string="vbv-maxrate=3000:vbv-bufsize=3000:strict-cbr=1:scenecut=40"',
            );
            expect(s).toContain('h265parse');
        });
        it('builds AV1 software with svtav1enc target-bitrate', () => {
            const s = branch('av1', 'software', 2000, 60);
            expect(s).toContain('svtav1enc name=venc0');
            expect(s).toContain('target-bitrate=2000');
            expect(s).toContain('av1parse');
        });
        it('throws on an unsupported codec/impl combo (av1 v4l2)', () => {
            expect(() => branch('av1', 'v4l2', 1000, 60)).toThrow();
        });
    });

    describe('parseResolution', () => {
        it('parses WxH strings', () => {
            expect(parseResolution('1280x720')).toEqual({ width: 1280, height: 720 });
            expect(parseResolution('3840x2160')).toEqual({ width: 3840, height: 2160 });
        });
        it('falls back to 1920x1080 on garbage', () => {
            expect(parseResolution('nope')).toEqual({ width: 1920, height: 1080 });
            expect(parseResolution('')).toEqual({ width: 1920, height: 1080 });
        });
    });

    describe('buildV4l2Source', () => {
        it('falls back to raw caps when the device cannot be probed', () => {
            const s = buildV4l2Source('/dev/video-nonexistent', 1920, 1080, 30);
            expect(s).toContain('v4l2src device=/dev/video-nonexistent');
            expect(s).toContain('video/x-raw,width=1920,height=1080');
            expect(s).toContain('video/x-raw,framerate=30/1');
        });
        it('threads videorate through the conversion tail so devices that cannot do the requested fps still negotiate cleanly', () => {
            // Cam Link 4K and similar HDMI capture devices only expose
            // specific framerates — without videorate the encoder fails
            // caps negotiation when the user picks an unsupported fps.
            const s = buildV4l2Source('/dev/video-nonexistent', 1920, 1080, 30);
            expect(s).toContain('videoscale n-threads=2');
            expect(s).toContain('videorate drop-only=true');
        });
    });

    describe('supportsLiveBitrate', () => {
        it('is true for v4l2 h264 and h265', () => {
            expect(supportsLiveBitrate('h264', 'v4l2')).toBe(true);
            expect(supportsLiveBitrate('h265', 'v4l2')).toBe(true);
        });
        it('is false for software encoders — vbv-maxrate is baked into option-string at element init and cannot be live-updated, so live bitrate changes would invalidate the configured VBV cap', () => {
            expect(supportsLiveBitrate('h264', 'software')).toBe(false);
            expect(supportsLiveBitrate('h265', 'software')).toBe(false);
        });
        it('is false for av1 (svtav1enc cannot reconfigure target-bitrate mid-stream)', () => {
            expect(supportsLiveBitrate('av1', 'software')).toBe(false);
        });
    });

    describe('getLiveUpdatableParams', () => {
        function makeConfigured(config: Record<string, unknown>) {
            const module = new VideoEncoderModule();
            (module as any).config = config;
            return module;
        }

        it('reports bitrate live when h264 v4l2 is available and selected', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
            const module = makeConfigured({ codec: 'h264', encoderImpl: 'v4l2' });
            expect(module.getLiveUpdatableParams()).toEqual(['bitrate']);
        });

        it('reports no live params for software encoders (VBV cap would go stale)', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['software'], h265: [], av1: [] });
            const module = makeConfigured({ codec: 'h264', encoderImpl: 'software' });
            expect(module.getLiveUpdatableParams()).toEqual([]);
        });

        it('reports no live params for av1 (encoder cannot live-reconfigure)', () => {
            VideoEncoderModule.setAvailableImpls({ h264: [], h265: [], av1: ['software'] });
            const module = makeConfigured({ codec: 'av1', encoderImpl: 'auto' });
            expect(module.getLiveUpdatableParams()).toEqual([]);
        });

        it('reports no live params when no impl is installed', () => {
            VideoEncoderModule.setAvailableImpls({ h264: [], h265: [], av1: [] });
            const module = makeConfigured({ codec: 'h264', encoderImpl: 'auto' });
            expect(module.getLiveUpdatableParams()).toEqual([]);
        });
    });

    describe('applyLiveBitrate', () => {
        function makeRunning(config: Record<string, unknown>) {
            const module = new VideoEncoderModule();
            (module as any).config = config;
            const setElementProperty = vi.fn().mockResolvedValue(undefined);
            (module as any).setElementProperty = setElementProperty;
            return { module, setElementProperty };
        }

        it('re-sends the FULL controls struct (mode pinned to VBR) on every v4l2 bitrate update — the driver keeps only the last write', async () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
            const { module, setElementProperty } = makeRunning({
                codec: 'h264',
                encoderImpl: 'v4l2',
                keyframeInterval: 60,
            });
            await (module as any).applyLiveBitrate(5000);
            expect(setElementProperty).toHaveBeenCalledTimes(1);
            const [name, prop, value] = setElementProperty.mock.calls[0];
            expect(name).toBe('venc0');
            expect(prop).toBe('extra-controls');
            expect(value).toContain('video_bitrate=5000000');
            expect(value).toContain('video_bitrate_mode=0');
            expect(value).toContain('repeat_sequence_header=1');
            expect(value).toContain('video_gop_size=60');
            expect(value).toContain('h264_i_frame_period=60');
        });

        it('uses h265_i_frame_period for v4l2 H.265', async () => {
            VideoEncoderModule.setAvailableImpls({ h264: [], h265: ['v4l2'], av1: [] });
            const { module, setElementProperty } = makeRunning({
                codec: 'h265',
                encoderImpl: 'v4l2',
                keyframeInterval: 90,
            });
            await (module as any).applyLiveBitrate(6000);
            const [, , value] = setElementProperty.mock.calls[0];
            expect(value).toContain('h265_i_frame_period=90');
            expect(value).toContain('video_bitrate_mode=0');
        });

        it('does nothing for software encoders — bitrate changes there must rebuild the pipeline so vbv-maxrate stays consistent', async () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['software'], h265: [], av1: [] });
            const { module, setElementProperty } = makeRunning({
                codec: 'h264',
                encoderImpl: 'software',
                keyframeInterval: 60,
            });
            await (module as any).applyLiveBitrate(5000);
            expect(setElementProperty).not.toHaveBeenCalled();
        });
    });

    describe('buildPipeline', () => {
        function makeModule() {
            const module = new VideoEncoderModule();
            const assignBusChannel = vi.fn(() => ({ port: 5000 }));
            const getBusChannel = vi.fn(() => ({ port: 5000 }));
            (module as any).services = {
                instanceId: 'video-enc-1',
                mediaRouter: { assignBusChannel, getBusChannel },
            };
            return module;
        }

        it('produces a valid H.264 V4L2 pipeline ending in the bus fan-out tee', () => {
            VideoEncoderModule.setAvailableImpls({
                h264: ['v4l2', 'software'],
                h265: [],
                av1: [],
            });
            const module = makeModule();
            // Use a nonexistent device path so buildV4l2Source goes through
            // the deterministic fallback branch (no device probe).
            const desc = module.buildPipeline({
                device: '/dev/video-nonexistent-for-test',
                codec: 'h264',
                encoderImpl: 'v4l2',
                resolution: '1920x1080',
                framerate: 30,
                bitrate: 4000,
                keyframeInterval: 60,
            });
            expect(desc).not.toBeNull();
            expect(desc!.pipeline).toContain('v4l2src device=/dev/video-nonexistent-for-test');
            expect(desc!.pipeline).toContain('v4l2h264enc name=venc0');
            expect(desc!.pipeline).toContain('mpegtsmux name=mux latency=0 alignment=7');
            // Bus egress: stripped + pinned TS caps, then a per-consumer
            // fan-out tee. The unixfdsink branches are attached at runtime by
            // the coordinator; allow-not-linked lets the encoder run with zero
            // consumers. The capssetter drops mpegtsmux's stale `streamheader`
            // before any branch (and any srtsink) can inherit it.
            expect(desc!.pipeline).toContain(
                'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                    'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                    'tee name=busout_5000 allow-not-linked=true',
            );
            expect(desc!.pipeline).not.toContain('udpsink');
            expect((module as any).busSinkName).toBe('busout_5000');
            expect(desc!.restartOnError).toBe(true);
            // v4l2src head into the aggregator mpegtsmux: the contract's house
            // clock without its base-time zeroing. Dropped, the mux schedules
            // off house time while the capture produces from its own zero and
            // releases video in GOP-sized ~2.3 s bursts — the pipeline string
            // asserted above is unchanged and every live consumer freezes.
            expect(desc!.liveCaptureClock).toBe(true);
        });

        it('falls back to a fakesink when no bus channel endpoint is assigned', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
            const module = makeModule();
            (module as any).services.mediaRouter.getBusChannel.mockReturnValue(undefined);
            const desc = module.buildPipeline({
                device: '/dev/video-nonexistent-for-test',
                codec: 'h264',
                encoderImpl: 'v4l2',
                resolution: '1920x1080',
                framerate: 30,
                bitrate: 4000,
                keyframeInterval: 60,
            });
            expect(desc!.pipeline).toContain('fakesink name=usink sync=false');
            expect(desc!.pipeline).not.toContain('tee name=busout_');
            expect((module as any).busSinkName).toBeUndefined();
        });

        it('inserts a leaky source-side queue (100ms) so encoder stalls do not back-pressure v4l2src into kernel-level frame drops', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
            const module = makeModule();
            const desc = module.buildPipeline({
                device: '/dev/video-nonexistent-for-test',
                codec: 'h264',
                encoderImpl: 'v4l2',
                resolution: '1920x1080',
                framerate: 30,
                bitrate: 4000,
                keyframeInterval: 60,
            });
            // The queue must sit immediately downstream of v4l2src, so that
            // back-pressure from videoconvert/videoscale/encoder is absorbed in
            // user-space rather than blocking v4l2src and filling the V4L2
            // kernel ringbuffer (kernel-level drops are invisible to GStreamer).
            const p = desc!.pipeline;
            expect(p).toContain('queue leaky=2 max-size-time=100000000');
            const idxV4l2 = p.indexOf('v4l2src');
            const idxQueue = p.indexOf('queue leaky=2 max-size-time=100000000');
            const idxConvert = p.indexOf('videoconvert');
            expect(idxV4l2).toBeLessThan(idxQueue);
            expect(idxQueue).toBeLessThan(idxConvert);
        });

        it('connects mpegtsmux straight to the bus egress with no leaky queue between — a drop there would slice the TS mid-stream and corrupt decode', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
            const module = makeModule();
            const desc = module.buildPipeline({
                device: '/dev/video-nonexistent-for-test',
                codec: 'h264',
                encoderImpl: 'v4l2',
                resolution: '1920x1080',
                framerate: 30,
                bitrate: 4000,
                keyframeInterval: 60,
            });
            // capssetter opens the bus egress (caps-only, no buffering) — what
            // must not appear between mux and tee is anything that can DROP.
            expect(desc!.pipeline).toMatch(/mpegtsmux name=mux[^!]+! capssetter/);
            expect(desc!.pipeline).not.toMatch(/mpegtsmux name=mux[^!]+! queue/);
        });

        it('returns null + sets health warning when no device is configured', () => {
            const module = makeModule();
            const setHealth = vi.fn();
            (module as any).setHealth = setHealth;
            expect(module.buildPipeline({})).toBeNull();
            expect(setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('No V4L2 device'),
            );
        });

        it('returns null + sets health error when the codec has no available encoder', () => {
            VideoEncoderModule.setAvailableImpls({ h264: [], h265: [], av1: [] });
            const module = makeModule();
            const setHealth = vi.fn();
            (module as any).setHealth = setHealth;
            expect(
                module.buildPipeline({
                    device: '/dev/video0',
                    codec: 'h264',
                    encoderImpl: 'auto',
                    resolution: '1920x1080',
                    framerate: 30,
                    bitrate: 4000,
                    keyframeInterval: 60,
                }),
            ).toBeNull();
            expect(setHealth).toHaveBeenCalledWith(
                'error',
                expect.stringContaining('No encoder available'),
            );
        });
    });

    describe('stats', () => {
        function makeStatsModule() {
            const module = new VideoEncoderModule() as any;
            module.services = {
                instanceId: 'video-enc-1',
                mediaRouter: { getBusChannel: vi.fn(() => ({ port: 5000 })) },
            };
            module.config = {
                codec: 'h264',
                resolution: '1920x1080',
                framerate: 30,
                bitrate: 6000,
            };
            module.setStatusData = vi.fn();
            module.setBadge = vi.fn();
            return module;
        }

        beforeEach(() =>
            VideoEncoderModule.setAvailableImpls({ h264: ['software'], h265: [], av1: [] }),
        );

        it('shows the configured target bitrate in the encoder stats', () => {
            const module = makeStatsModule();
            module.updateStatusData();
            expect(module.setStatusData).toHaveBeenCalledWith(
                'encoder',
                expect.objectContaining({ bitrate: 6000 }),
            );
        });

        it('reports the assigned bus channel in the bus stats section', () => {
            const module = makeStatsModule();
            module.updateStatusData();
            expect(module.setStatusData).toHaveBeenCalledWith('bus', { channel: 5000 });
        });

        it('reports channel 0 when no bus channel is assigned', () => {
            const module = makeStatsModule();
            module.services.mediaRouter.getBusChannel.mockReturnValue(undefined);
            module.updateStatusData();
            expect(module.setStatusData).toHaveBeenCalledWith('bus', { channel: 0 });
        });

        it('puts the live rate in the popup and a bitrate badge on the face', () => {
            const module = makeStatsModule();
            module.publishThroughput({ bitrateKbps: 5900, totalBytes: 10 * 1024 * 1024 });
            expect(module.setStatusData).toHaveBeenCalledWith(
                'throughput',
                expect.objectContaining({ 'Output Bitrate': '5900 kbps' }),
            );
            expect(module.setBadge).toHaveBeenCalledWith('bitrate', bitrateBadge(5900));
            expect(bitrateBadge(5900)).toEqual({
                icon: 'activity',
                text: '5.9 Mbps',
                color: '#10b981',
            });
        });
    });

    describe('v4l2 device-provider demand', () => {
        // Field finding (Pi 400): the `video` provider ran `v4l2-ctl` over every
        // /dev/video* node every 2 s — 12.4 % of a core — on a host with no
        // video encoder at all. The provider now enumerates only while an
        // instance holds a demand token.
        const acquire = engine.acquireV4l2Demand as unknown as ReturnType<typeof vi.fn>;
        const release = engine.releaseV4l2Demand as unknown as ReturnType<typeof vi.fn>;
        const register = engine.registerV4l2DeviceProvider as unknown as ReturnType<typeof vi.fn>;

        beforeEach(() => {
            acquire.mockClear();
            release.mockClear();
            register.mockClear();
        });

        it('registers the demand-gated provider instead of a bare 2 s poll', () => {
            const services = { deviceProviders: { register: vi.fn() } } as any;
            VideoEncoderModule.registerServices(services);
            expect(register).toHaveBeenCalledWith(services);
            // The plugin no longer registers a provider of its own — the
            // ungated `list: () => listV4l2Devices()` was the burn.
            expect(services.deviceProviders.register).not.toHaveBeenCalled();
        });

        it('claims the cadence at CONSTRUCTION, not at start — a stopped module still shows a picker', () => {
            new VideoEncoderModule();
            expect(acquire).toHaveBeenCalledTimes(1);
            expect(release).not.toHaveBeenCalled();
        });

        it('releases the claim when the instance is destroyed', async () => {
            const module = new VideoEncoderModule();
            await module.onDestroy();
            expect(release).toHaveBeenCalledTimes(1);
        });

        it('a second destroy cannot release another instance’s claim', async () => {
            const module = new VideoEncoderModule();
            await module.onDestroy();
            await module.onDestroy();
            expect(release).toHaveBeenCalledTimes(1);
        });
    });
});

describe('capture scale stage', () => {
    it('offloads scale+convert to v4l2convert when the v4l2 encoder has the Pi ISP scaler', () => {
        VideoEncoderModule.setAvailableImpls(
            { h264: ['v4l2'], h265: [], av1: [] },
            { va: false, v4l2: true },
        );
        const mod = new VideoEncoderModule();
        const desc = mod.buildPipeline({
            device: '/dev/video0',
            codec: 'h264',
            encoderImpl: 'v4l2',
            resolution: '1280x720',
            framerate: 25,
            bitrate: 6928,
        });
        expect(desc?.pipeline).toContain(
            'video/x-raw,framerate=25/1 ! v4l2convert ! video/x-raw,width=1280,height=720 ! v4l2h264enc',
        );
        expect(desc?.pipeline).not.toContain('videoscale');
    });
    it('stays on threaded software scaling when no hardware scaler is installed', () => {
        VideoEncoderModule.setAvailableImpls({ h264: ['v4l2'], h265: [], av1: [] });
        const mod = new VideoEncoderModule();
        const desc = mod.buildPipeline({
            device: '/dev/video0',
            codec: 'h264',
            encoderImpl: 'v4l2',
            resolution: '1280x720',
            framerate: 25,
            bitrate: 6928,
        });
        expect(desc?.pipeline).toContain(
            'videoscale n-threads=2 ! video/x-raw,width=1280,height=720 ! videoconvert n-threads=2 ! v4l2h264enc',
        );
    });
});

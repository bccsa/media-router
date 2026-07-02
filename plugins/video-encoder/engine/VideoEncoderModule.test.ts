import { describe, it, expect, vi, beforeEach } from 'vitest';

// `initManifest` now delegates the element probing to the engine's shared
// `probeEncoderAvailability` (which calls `probeGstElement` internally, not
// through this barrel). Mock that helper to control availability; the real
// `applyEncoderAvailabilityToManifest`, `buildEncoderBranch` and `resolveImpl`
// come through from `...actual`. The element-probing logic itself is covered by
// packages/engine/src/plugins/encoderManifest.test.ts.
vi.mock('@media-router/engine', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@media-router/engine');
    return {
        ...actual,
        probeEncoderAvailability: vi.fn(),
    };
});

import * as engine from '@media-router/engine';
import { buildEncoderBranch, resolveImpl } from '@media-router/engine';
import { VideoEncoderModule } from './VideoEncoderModule.js';
import { buildV4l2Source, parseResolution, supportsLiveBitrate } from './videoEncoderPipeline.js';

const probeMock = engine.probeEncoderAvailability as unknown as ReturnType<typeof vi.fn>;

function setAvailability(availability: Record<string, string[]>) {
    probeMock.mockResolvedValue(availability);
}

describe('VideoEncoderModule', () => {
    beforeEach(() => {
        probeMock.mockReset();
        // Reset the static availability map between tests so stale state from
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
        // knobs stay at the shared builder's defaults (CBR, auto profile,
        // scenecut 40 — x264's own default, so it's behaviourally neutral).
        const branch = (codec: 'h264' | 'h265' | 'av1', impl: 'v4l2' | 'software', bitrateKbps: number, kif: number) =>
            buildEncoderBranch({ codec, impl, bitrateKbps, kif, name: 'venc0', speedPreset: 'superfast' });

        it('builds H.264 V4L2 with CBR mode (video_bitrate_mode=1), bitrate, and keyframe period', () => {
            const s = branch('h264', 'v4l2', 4000, 60);
            expect(s).toContain('v4l2h264enc name=venc0');
            expect(s).toContain('video_bitrate=4000000');
            // CBR mode is load-bearing — without it the V4L2 driver picks its
            // default (typically VBR) and bursts well above target on motion.
            expect(s).toContain('video_bitrate_mode=1');
            expect(s).toContain('h264_i_frame_period=60');
            expect(s).toContain('h264parse');
        });
        it('builds H.265 V4L2 with CBR mode and the H.265 keyframe-period control', () => {
            const s = branch('h265', 'v4l2', 5000, 90);
            expect(s).toContain('v4l2h265enc name=venc0');
            expect(s).toContain('video_bitrate=5000000');
            expect(s).toContain('video_bitrate_mode=1');
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
            expect(s).toContain('option-string="nal-hrd=cbr:vbv-maxrate=3500:vbv-bufsize=3500:scenecut=40"');
            expect(s).toContain('h264parse');
        });
        it('builds H.265 software as CBR (strict-cbr, peak capped at target)', () => {
            const s = branch('h265', 'software', 3000, 30);
            expect(s).toContain('x265enc name=venc0');
            expect(s).toContain('speed-preset=superfast');
            expect(s).toContain('bitrate=3000');
            expect(s).toContain('option-string="vbv-maxrate=3000:vbv-bufsize=3000:strict-cbr=1:scenecut=40"');
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
            expect(s).toContain('video/x-raw,width=1920,height=1080,framerate=30/1');
        });
        it('threads videorate through the conversion tail so devices that cannot do the requested fps still negotiate cleanly', () => {
            // Cam Link 4K and similar HDMI capture devices only expose
            // specific framerates — without videorate the encoder fails
            // caps negotiation when the user picks an unsupported fps.
            const s = buildV4l2Source('/dev/video-nonexistent', 1920, 1080, 30);
            expect(s).toContain('videoconvert ! videorate ! videoscale');
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

        it('re-asserts video_bitrate_mode=1 (CBR) on every v4l2 bitrate update — drivers store the full controls struct from the last write, so dropping the mode silently reverts to VBR', async () => {
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
            expect(value).toContain('video_bitrate_mode=1');
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
            expect(value).toContain('video_bitrate_mode=1');
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
            const assignUdpPort = vi.fn(() => ({ host: '239.255.0.1', port: 5000 }));
            const getUdpEndpoint = vi.fn(() => ({ host: '239.255.0.1', port: 5000 }));
            (module as any).services = {
                instanceId: 'video-enc-1',
                mediaRouter: { assignUdpPort, getUdpEndpoint },
            };
            return module;
        }

        it('produces a valid H.264 V4L2 pipeline with udpsink + mpegtsmux', () => {
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
            expect(desc!.pipeline).toContain(
                'udpsink name=usink host=239.255.0.1 port=5000 multicast-iface=lo auto-multicast=true buffer-size=4194304 sync=false',
            );
            expect(desc!.liveElements).toEqual({ venc0: ['extra-controls'] });
            expect(desc!.restartOnError).toBe(true);
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

        it('connects mpegtsmux straight to udpsink with no leaky queue between — a leaky queue here would drop mid-stream UDP buffers and corrupt decode', () => {
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
            expect(desc!.pipeline).toMatch(/mpegtsmux name=mux[^!]+! udpsink/);
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
});

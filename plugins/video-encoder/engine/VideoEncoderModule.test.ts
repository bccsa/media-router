import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@media-router/engine', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@media-router/engine');
    return {
        ...actual,
        probeGstElement: vi.fn(),
    };
});

import * as engine from '@media-router/engine';
import { VideoEncoderModule } from './VideoEncoderModule.js';
import {
    buildEncoderBranch,
    buildV4l2Source,
    parseResolution,
    resolveImpl,
    supportsLiveBitrate,
} from './videoEncoderPipeline.js';

const probeMock = engine.probeGstElement as unknown as ReturnType<typeof vi.fn>;

function setProbe(available: Record<string, boolean>) {
    probeMock.mockImplementation(async (name: string) => !!available[name]);
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
            setProbe({
                v4l2h264enc: true,
                x264enc: true,
                v4l2h265enc: false,
                x265enc: true,
                svtav1enc: false,
            });
            const manifest: Record<string, any> = {
                configSchema: {
                    properties: {
                        codec: { enum: ['h264', 'h265', 'av1'] },
                        encoderImpl: { enum: ['auto', 'v4l2', 'software'] },
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
            setProbe({});
            const manifest: Record<string, any> = {
                configSchema: {
                    properties: {
                        codec: { enum: ['h264'] },
                        encoderImpl: { enum: ['auto', 'v4l2', 'software'] },
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
        it('builds H.264 V4L2 with extra-controls bitrate + keyframe period', () => {
            const s = buildEncoderBranch('h264', 'v4l2', 4000, 60);
            expect(s).toContain('v4l2h264enc name=venc0');
            expect(s).toContain('video_bitrate=4000000');
            expect(s).toContain('h264_i_frame_period=60');
            expect(s).toContain('h264parse');
        });
        it('builds H.264 software with x264enc kbps bitrate', () => {
            const s = buildEncoderBranch('h264', 'software', 3500, 90);
            expect(s).toContain('x264enc name=venc0');
            expect(s).toContain('bitrate=3500');
            expect(s).toContain('key-int-max=90');
            expect(s).toContain('h264parse');
        });
        it('builds H.265 software with x265enc', () => {
            const s = buildEncoderBranch('h265', 'software', 3000, 30);
            expect(s).toContain('x265enc name=venc0');
            expect(s).toContain('h265parse');
        });
        it('builds AV1 software with svtav1enc target-bitrate', () => {
            const s = buildEncoderBranch('av1', 'software', 2000, 60);
            expect(s).toContain('svtav1enc name=venc0');
            expect(s).toContain('target-bitrate=2000');
            expect(s).toContain('av1parse');
        });
        it('throws on an unsupported codec/impl combo (av1 v4l2)', () => {
            expect(() => buildEncoderBranch('av1', 'v4l2', 1000, 60)).toThrow();
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
    });

    describe('supportsLiveBitrate', () => {
        it('is true for h264 and h265', () => {
            expect(supportsLiveBitrate('h264')).toBe(true);
            expect(supportsLiveBitrate('h265')).toBe(true);
        });
        it('is false for av1 (svtav1enc cannot reconfigure target-bitrate mid-stream)', () => {
            expect(supportsLiveBitrate('av1')).toBe(false);
        });
    });

    describe('getLiveUpdatableParams', () => {
        function makeConfigured(config: Record<string, unknown>) {
            const module = new VideoEncoderModule();
            (module as any).config = config;
            return module;
        }

        it('reports bitrate live when h264 software is available and selected', () => {
            VideoEncoderModule.setAvailableImpls({ h264: ['software'], h265: [], av1: [] });
            const module = makeConfigured({ codec: 'h264', encoderImpl: 'software' });
            expect(module.getLiveUpdatableParams()).toEqual(['bitrate']);
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

    describe('buildPipeline', () => {
        function makeModule() {
            const module = new VideoEncoderModule();
            const assignEncoderPort = vi.fn(() => ({ host: '239.255.0.1', port: 5000 }));
            const getEncoderEndpoint = vi.fn(() => ({ host: '239.255.0.1', port: 5000 }));
            (module as any).services = {
                instanceId: 'video-enc-1',
                mediaRouter: { assignEncoderPort, getEncoderEndpoint },
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
                'udpsink name=usink host=239.255.0.1 port=5000 multicast-iface=lo auto-multicast=true buffer-size=2097152 sync=false',
            );
            expect(desc!.liveElements).toEqual({ venc0: ['extra-controls'] });
            expect(desc!.restartOnError).toBe(true);
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

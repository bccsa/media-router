import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    VideoPlayerModule,
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildSink,
} from './VideoPlayerModule.js';

describe('VideoPlayerModule helpers', () => {
    beforeEach(() => {
        // Reset any cached probe state so each test sets its own.
        VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
    });

    describe('buildSink', () => {
        const both = { wayland: true, kms: true };
        it('prefers waylandsink when a compositor session is reachable', () => {
            expect(buildSink('', { ...both, waylandSession: true })).toBe(
                'waylandsink name=sink sync=false',
            );
            // ignores `display` config: compositor decides output
            expect(buildSink('HDMI-A-1', { ...both, waylandSession: true })).toBe(
                'waylandsink name=sink sync=false',
            );
        });
        it('targets kmssink by numeric connector-id (older kmssink builds reject connector-name)', () => {
            expect(
                buildSink('HDMI-A-1', { ...both, waylandSession: false, connectorId: 32 }),
            ).toBe('kmssink name=sink connector-id=32 sync=false');
        });
        it('falls back to auto-pick kmssink when the connector id can not be resolved', () => {
            // Picked a display but sysfs lookup returned undefined — better to
            // auto-pick than emit `connector-name=...` which older kmssink
            // builds reject with a parse error.
            expect(buildSink('HDMI-A-1', { ...both, waylandSession: false })).toBe(
                'kmssink name=sink sync=false',
            );
        });
        it('uses kmssink without a connector when display is unset', () => {
            expect(buildSink('', { ...both, waylandSession: false })).toBe(
                'kmssink name=sink sync=false',
            );
        });
        it('falls back to autovideosink when neither sink is installed', () => {
            expect(
                buildSink('', { wayland: false, kms: false, waylandSession: false }),
            ).toBe('autovideosink sync=false');
        });
        it('uses kmssink even with a compositor present when waylandsink is missing', () => {
            expect(
                buildSink('HDMI-A-1', {
                    wayland: false,
                    kms: true,
                    waylandSession: true,
                    connectorId: 32,
                }),
            ).toBe('kmssink name=sink connector-id=32 sync=false');
        });
    });

    describe('buildFallbackOnlyPipeline', () => {
        it('renders videotestsrc + textoverlay into the sink', () => {
            const s = buildFallbackOnlyPipeline('No video', 'autovideosink sync=false');
            expect(s).toContain('videotestsrc');
            expect(s).toContain('pattern=smpte');
            expect(s).toContain('textoverlay name=nov text="No video"');
            expect(s).toContain('autovideosink');
        });
    });

    describe('buildLivePipeline', () => {
        it('wires udpsrc → tsdemux → decodebin → sink for multicast', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('udpsrc multicast-group=239.255.0.1 port=5000');
            expect(s).toContain('tsdemux');
            expect(s).toContain('decodebin');
            expect(s).toContain('kmssink name=sink');
            // No fallback branch when a source is connected.
            expect(s).not.toContain('input-selector');
            expect(s).not.toContain('videotestsrc');
        });

        it('drops multicast-group for unicast sources', () => {
            const s = buildLivePipeline('autovideosink sync=false', {
                host: '127.0.0.1',
                port: 6000,
            });
            expect(s).toContain('udpsrc port=6000');
            expect(s).not.toContain('multicast-group');
        });
        it('arms udpsrc with a 5s timeout so a stalled stream triggers restart', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('timeout=5000000000');
        });
        it('inserts tsparse between udpsrc and tsdemux to re-anchor PCR to the local clock', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('tsparse set-timestamps=true');
            const idxUdp = s.indexOf('udpsrc');
            const idxTsparse = s.indexOf('tsparse');
            const idxTsdemux = s.indexOf('tsdemux');
            expect(idxUdp).toBeLessThan(idxTsparse);
            expect(idxTsparse).toBeLessThan(idxTsdemux);
        });
    });

    describe('buildPipeline', () => {
        function makeModule() {
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleUdpSource: vi.fn() },
            };
            (module as any).setHealth = vi.fn();
            return module;
        }

        it('returns a fallback-only pipeline when no source is connected', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleUdpSource.mockReturnValue(undefined);
            const desc = module.buildPipeline({ fallbackText: 'Nothing here', display: '' });
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).toContain('Nothing here');
            expect(desc.pipeline).not.toContain('input-selector');
            expect(desc.liveElements).toEqual({ nov: ['text'] });
            expect((module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('No video'),
            );
        });

        it('returns the live pipeline when a UDP source is assigned (KMS path)', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleUdpSource.mockReturnValue({
                host: '239.255.0.1',
                port: 5500,
                connectionId: 'enc-1:mpegts-out-player-1:mpegts-in',
                sourceModuleId: 'enc-1',
                sourcePortId: 'mpegts-out',
            });
            const desc = module.buildPipeline({
                fallbackText: 'No video',
                display: 'HDMI-A-1',
            });
            expect(desc.pipeline).toContain('udpsrc multicast-group=239.255.0.1');
            expect(desc.pipeline).toContain('tsdemux');
            expect(desc.pipeline).toContain('decodebin');
            // On a test machine without /sys/class/drm, resolveConnectorId returns
            // undefined → kmssink falls back to auto-pick (no connector-id prop).
            expect(desc.pipeline).toContain('kmssink name=sink');
            expect(desc.pipeline).not.toContain('connector-name=');
            expect(desc.pipeline).not.toContain('videotestsrc');
            expect(desc.liveElements).toEqual({});
        });
    });
});

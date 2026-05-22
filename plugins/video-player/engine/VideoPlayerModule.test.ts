import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    VideoPlayerModule,
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildPipelineEnv,
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
            // Empty display → no env override (let the compositor decide).
            expect(desc.env).toEqual({});
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
                (module as any).services.mediaRouter.getModuleUdpSource.mockReturnValue(undefined);
                const desc = module.buildPipeline({
                    fallbackText: 'No video',
                    display: 'DSI-2',
                });
                expect(desc.pipeline).toContain('waylandsink name=sink');
                expect(desc.env).toEqual({ MR_GLIB_PRGNAME: 'local.mr.DSI-2' });
            } finally {
                fs.rmSync(tmpRuntime, { recursive: true, force: true });
                if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
                else delete process.env.XDG_RUNTIME_DIR;
            }
        });
    });

    describe('onLiveConfigUpdate', () => {
        function makeRunningModule(opts: { hasSource: boolean }) {
            const module = new VideoPlayerModule();
            const setProperty = vi.fn().mockResolvedValue(undefined);
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: {
                    getModuleUdpSource: vi.fn(() =>
                        opts.hasSource
                            ? { host: '239.255.0.1', port: 5500 }
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
    });
});

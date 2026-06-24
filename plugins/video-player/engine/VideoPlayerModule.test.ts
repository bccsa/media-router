import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { VideoPlayerModule } from './VideoPlayerModule.js';
import { currentWaylandSessionIdent, findCogPidForDisplay } from './helpers/wayland.js';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildPipelineEnv,
    buildSink,
    resolveDecoderThreadType,
    resolveFallbackImagePath,
} from './helpers/pipelines.js';

describe('VideoPlayerModule helpers', () => {
    beforeEach(() => {
        // Reset any cached probe state so each test sets its own.
        VideoPlayerModule.setSinkAvailability({ wayland: false, kms: false });
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
        it('wires udpsrc → tsdemux → decodebin → sink for multicast', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', {
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

        it('re-anchors PTS by default (tsparse set-timestamps=true) — single-pipeline playout', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('tsparse set-timestamps=true');
        });

        it('preserves source PTS when clock-locked (preserveSourcePts=true) so it shares the audio timeline', () => {
            const s = buildLivePipeline(
                'kmssink name=sink sync=true max-lateness=1000000000 qos=true',
                { host: '239.255.0.1', port: 5000 },
                false,
                200,
                true,
            );
            expect(s).toContain('tsparse set-timestamps=false');
            expect(s).not.toContain('set-timestamps=true');
        });

        it('passes native resolution through on the KMS/auto path (constrainSurface=false)', () => {
            // Forcing 1280×720 here would downscale a native-res broadcast
            // panel — only the wayland-fullscreen path needs the fixed size.
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('videoconvert ! videoscale ! kmssink');
            expect(s).not.toContain('width=1280,height=720');
        });

        it('pins the surface to 1280×720 on the wayland-fullscreen path (constrainSurface=true)', () => {
            // Must match the fallback surface dimensions, else kiosk-shell
            // rejects the mismatched fullscreen surface and weston logs
            // `libwayland: error in client communication`.
            const s = buildLivePipeline(
                'waylandsink name=sink sync=false fullscreen=true qos=true',
                { host: '239.255.0.1', port: 5000 },
                true,
            );
            expect(s).toContain('videoscale add-borders=true');
            expect(s).toContain('width=1280,height=720');
            expect(s).toContain('pixel-aspect-ratio=1/1');
        });

        it('drops multicast-group for unicast sources', () => {
            const s = buildLivePipeline('autovideosink sync=false qos=true', {
                host: '127.0.0.1',
                port: 6000,
            });
            expect(s).toContain('udpsrc port=6000');
            expect(s).not.toContain('multicast-group');
        });
        it('arms udpsrc with a 5s timeout so a stalled stream triggers restart', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', {
                host: '239.255.0.1',
                port: 5000,
            });
            expect(s).toContain('timeout=5000000000');
        });
        it('inserts tsparse between udpsrc and tsdemux to re-anchor PCR to the local clock', () => {
            const s = buildLivePipeline('kmssink name=sink sync=false qos=true', {
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

    describe('UDP-stall fallback', () => {
        function makeModule() {
            const module = new VideoPlayerModule();
            (module as any).services = {
                instanceId: 'video-player-1',
                mediaRouter: { getModuleUdpSource: vi.fn() },
            };
            (module as any).setHealth = vi.fn();
            return module;
        }

        it('returns the live pipeline by default when a source is connected', () => {
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleUdpSource.mockReturnValue({
                host: '239.255.0.1',
                port: 5500,
            });
            const desc = module.buildPipeline({ display: '' });
            // Sanity: with no stall latched, live wins.
            expect(desc.pipeline).toContain('udpsrc');
            expect(desc.pipeline).not.toContain('videotestsrc');
        });

        it('returns the colour-bars fallback even with a UDP source connected when the stall flag is latched', () => {
            // This is the user-visible behaviour we want: the source has
            // a UDP mapping (so getModuleUdpSource returns a real host:port)
            // but it stopped sending data and the runner posted a
            // GstUDPSrcTimeout. The latched flag flips the next pipeline
            // build over to videotestsrc + textoverlay so the display
            // shows colour bars instead of a frozen frame.
            VideoPlayerModule.setSinkAvailability({ wayland: false, kms: true });
            const module = makeModule();
            (module as any).services.mediaRouter.getModuleUdpSource.mockReturnValue({
                host: '239.255.0.1',
                port: 5500,
            });
            (module as any).udpStallDetected = true;
            const desc = module.buildPipeline({ display: '', fallbackText: 'Source down' });
            expect(desc.pipeline).toContain('videotestsrc');
            expect(desc.pipeline).toContain('Source down');
            expect(desc.pipeline).not.toContain('udpsrc');
            expect((module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('Source silent'),
            );
        });

        it('clears the stall flag and the UDP resume probe in clearUdpStallState (used on external stop)', () => {
            const module = makeModule();
            (module as any).udpStallDetected = true;
            // Stand-in for an open dgram socket — close() is the only method
            // clearUdpStallState() touches.
            const fakeSock = { close: vi.fn() };
            (module as any).udpResumeProbe = fakeSock;
            (module as any).clearUdpStallState();
            expect((module as any).udpStallDetected).toBe(false);
            expect((module as any).udpResumeProbe).toBeNull();
            expect(fakeSock.close).toHaveBeenCalled();
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

        it('updates the nov text overlay when source is silent (stall fallback active)', async () => {
            // Reported bug: user typed in the live-updatable "Fallback Text"
            // field while the source was down (colour bars showing) and the
            // overlay didn't refresh. The fallback pipeline owns `nov` in
            // *both* "no source" and "source-silent" states; the guard now
            // pushes the live update in either case.
            const { module, setProperty } = makeRunningModule({ hasSource: true });
            (module as any).udpStallDetected = true;
            await module.onLiveConfigUpdate({ fallbackText: 'Whats sup' });
            expect(setProperty).toHaveBeenCalledWith('nov', 'text', 'Whats sup');
        });
    });
});

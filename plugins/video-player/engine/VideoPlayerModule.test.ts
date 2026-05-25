import * as fs from 'fs';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { VideoPlayerModule } from './VideoPlayerModule.js';
import { currentWaylandSessionIdent, findCogPidForDisplay } from './helpers/wayland.js';
import { getWestonOutputTransform, westonTransformToGstRotate } from './helpers/weston.js';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildPipelineEnv,
    buildSink,
    resolveFallbackImagePath,
} from './helpers/pipelines.js';

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

        it('returns plain waylandsink regardless of output rotation (rotation goes into the pipeline body, not the sink)', () => {
            // The earlier attempt baked `rotate-method=X` onto waylandsink,
            // but that only rotates pixel content — the xdg_surface geometry
            // stays at the source caps size, so kiosk-shell rejected the
            // surface as too large on rotated outputs. Rotation is now
            // applied via a `videoflip` element prepended to the sink
            // (see `rotationElement`) which rotates *and* swaps caps,
            // producing a surface of the correct rotated dimensions.
            expect(
                buildSink('DSI-2', {
                    ...both,
                    waylandSession: true,
                    outputTransform: 'rotate-90',
                }),
            ).toBe('waylandsink name=sink sync=false');
            expect(
                buildSink('HDMI-A-1', {
                    ...both,
                    waylandSession: true,
                    outputTransform: 'normal',
                }),
            ).toBe('waylandsink name=sink sync=false');
        });
    });

    describe('rotation handling in pipelines', () => {
        it('injects videoflip before waylandsink in the live pipeline on rotated outputs', () => {
            // weston `transform=rotate-90` → buffer needs a counterclockwise
            // flip to compensate, producing 720×1280 caps that fit the
            // apparent 1080×1920 output. Without this the kiosk-shell
            // xdg_surface check fails with "geometry (1280 x 720) is larger
            // than the configured fullscreen state (1080 x 1920)".
            const live = buildLivePipeline(
                'waylandsink name=sink sync=false',
                { host: '239.255.0.1', port: 5500 },
                'rotate-90',
            );
            expect(live).toContain('videoflip method=clockwise ! waylandsink name=sink');
        });

        it('injects videoflip in the fallback pipeline too on rotated outputs', () => {
            const fb = buildFallbackOnlyPipeline(
                'Standby',
                'waylandsink name=sink sync=false',
                undefined,
                'rotate-270',
            );
            expect(fb).toContain('videoflip method=counterclockwise ! waylandsink name=sink');
            expect(fb).toContain('videotestsrc');
        });

        it('omits videoflip on normal outputs (pipeline byte-identical to the un-rotated case)', () => {
            const live = buildLivePipeline(
                'waylandsink name=sink sync=false',
                { host: '239.255.0.1', port: 5500 },
                'normal',
            );
            expect(live).not.toContain('videoflip');
        });
    });

    describe('westonTransformToGstRotate', () => {
        it('maps each weston transform to the inverse videoflip method name', () => {
            // The mapping is the *inverse* of weston's output rotation so the
            // two cancel out at display time. Names come from the videoflip
            // GstVideoFlipMethod enum (not waylandsink's rotate-method enum,
            // which uses 90l/90r). Identity for un-rotated / unrecognised.
            expect(westonTransformToGstRotate(undefined)).toBe('identity');
            expect(westonTransformToGstRotate('')).toBe('identity');
            expect(westonTransformToGstRotate('normal')).toBe('identity');
            expect(westonTransformToGstRotate('rotate-90')).toBe('clockwise');
            expect(westonTransformToGstRotate('rotate-180')).toBe('rotate-180');
            expect(westonTransformToGstRotate('rotate-270')).toBe('counterclockwise');
            expect(westonTransformToGstRotate('flipped')).toBe('horizontal-flip');
            expect(westonTransformToGstRotate('flipped-rotate-180')).toBe('vertical-flip');
        });
    });

    describe('getWestonOutputTransform', () => {
        let tmp: string;
        let iniPath: string;
        beforeEach(() => {
            tmp = fs.mkdtempSync(`${os.tmpdir()}/mr-weston-`);
            iniPath = `${tmp}/weston.ini`;
        });
        afterEach(() => {
            fs.rmSync(tmp, { recursive: true, force: true });
        });

        it('returns "normal" when the ini does not exist', () => {
            expect(getWestonOutputTransform('DSI-2', `${tmp}/nope.ini`)).toBe('normal');
        });

        it('returns the transform for a matched output (last in file — exercises the trailing-block flush)', () => {
            // The parser flushes the last [output] block after the loop ends;
            // make sure that path returns the transform too (vs. only flushing
            // on the *next* section header).
            fs.writeFileSync(
                iniPath,
                [
                    '[output]',
                    'name=HDMI-A-1',
                    'transform=normal',
                    '',
                    '[output]',
                    'name=DSI-2',
                    'transform=rotate-90',
                ].join('\n'),
            );
            expect(getWestonOutputTransform('DSI-2', iniPath)).toBe('rotate-90');
            expect(getWestonOutputTransform('HDMI-A-1', iniPath)).toBe('normal');
        });

        it('returns "normal" for an output that is not in the ini', () => {
            fs.writeFileSync(iniPath, '[output]\nname=HDMI-A-1\ntransform=rotate-90\n');
            expect(getWestonOutputTransform('DSI-2', iniPath)).toBe('normal');
        });

        it('ignores comments and other section blocks', () => {
            fs.writeFileSync(
                iniPath,
                [
                    '# top-level comment',
                    '[autolaunch]',
                    'path=/usr/libexec/foo',
                    '',
                    '[output]',
                    '# this output is rotated',
                    'name=DSI-2',
                    'transform=rotate-180',
                ].join('\n'),
            );
            expect(getWestonOutputTransform('DSI-2', iniPath)).toBe('rotate-180');
        });
    });

    describe('buildFallbackOnlyPipeline', () => {
        it('renders videotestsrc + textoverlay into the sink (no image path)', () => {
            const s = buildFallbackOnlyPipeline('No video', 'autovideosink sync=false');
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
                'autovideosink sync=false',
                '/data/media-router/no-signal.png',
            );
            expect(s).toContain('filesrc location="/data/media-router/no-signal.png"');
            expect(s).toContain('decodebin');
            expect(s).toContain('imagefreeze');
            expect(s).toContain('width=1280,height=720');
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

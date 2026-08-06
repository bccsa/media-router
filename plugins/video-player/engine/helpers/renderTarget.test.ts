import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Everything here reads sysfs through the engine's DRM helpers. Passthrough
// spies let each test state the connector world it means, instead of whatever
// the box running the suite happens to have plugged in.
vi.mock('@media-router/engine', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        listDrmConnectors: vi.fn(),
        firstConnectedDisplay: vi.fn(),
        pickActiveDisplay: vi.fn(),
        resolveConnectorMode: vi.fn(),
    };
});

import {
    firstConnectedDisplay,
    listDrmConnectors,
    pickActiveDisplay,
    resolveConnectorMode,
} from '@media-router/engine';
import {
    activeDisplayName,
    describeRenderPath,
    resolveFallbackSurface,
    resolveRenderTarget,
} from './renderTarget.js';
import { DEFAULT_SURFACE } from './pipelines.js';

const listMock = listDrmConnectors as unknown as ReturnType<typeof vi.fn>;
const firstMock = firstConnectedDisplay as unknown as ReturnType<typeof vi.fn>;
const pickMock = pickActiveDisplay as unknown as ReturnType<typeof vi.fn>;
const modeMock = resolveConnectorMode as unknown as ReturnType<typeof vi.fn>;

/** Connector name deliberately absent from any real weston.ini on the host. */
const UNLISTED_CONNECTOR = 'HDMI-A-9';

const connected = (name: string) => ({ name, label: name, meta: { status: 'connected' } });
const disconnected = (name: string) => ({ name, label: name, meta: { status: 'disconnected' } });
const choice = (name: string, connectorId?: number, substituted = false) => ({
    name,
    connectorId,
    substituted,
});

describe('renderTarget', () => {
    let tmp: string;
    let prevRuntime: string | undefined;

    beforeEach(() => {
        // Default world: no DRM subsystem, no compositor — the dev-machine path.
        listMock.mockReturnValue([]);
        firstMock.mockReturnValue(undefined);
        pickMock.mockReturnValue(choice('', undefined));
        modeMock.mockReturnValue(undefined);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-render-target-'));
        prevRuntime = process.env.XDG_RUNTIME_DIR;
        process.env.XDG_RUNTIME_DIR = tmp;
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (prevRuntime !== undefined) process.env.XDG_RUNTIME_DIR = prevRuntime;
        else delete process.env.XDG_RUNTIME_DIR;
        vi.clearAllMocks();
    });

    /** Make a compositor socket reachable for `hasWaylandSession()`. */
    function withCompositor(): void {
        fs.writeFileSync(path.join(tmp, 'wayland-1'), '');
    }

    describe('resolveRenderTarget — headless guard', () => {
        it('vetoes the build when DRM exists but nothing is connected', () => {
            // A sink would only error-loop: kmssink has no connector to drive
            // and the compositor can't start without a display.
            listMock.mockReturnValue([disconnected('HDMI-A-1'), connected('Writeback-1')]);
            expect(resolveRenderTarget('', { wayland: true, kms: true })).toEqual({
                kind: 'blocked',
                health: 'error',
                message: 'No display connected — video output unavailable',
            });
        });

        it('honours an explicitly selected connector that IS connected (Writeback capture)', () => {
            listMock.mockReturnValue([connected('Writeback-1')]);
            pickMock.mockReturnValue(choice('Writeback-1', 5));
            const target = resolveRenderTarget('Writeback-1', { wayland: false, kms: true });
            expect(target.kind).toBe('ready');
        });

        it('skips the guard entirely on hosts with no DRM subsystem (dev machines)', () => {
            const target = resolveRenderTarget('', { wayland: false, kms: false });
            expect(target.kind).toBe('ready');
        });
    });

    describe('resolveRenderTarget — compositor gate', () => {
        it('idles instead of grabbing the DRM master while the compositor starts', () => {
            // kmssink would take the master and fight the starting compositor
            // for it — the hotplug flash-then-vanish failure.
            listMock.mockReturnValue([connected('HDMI-A-1')]);
            firstMock.mockReturnValue('HDMI-A-1');
            expect(resolveRenderTarget('', { wayland: true, kms: true })).toEqual({
                kind: 'blocked',
                health: 'warning',
                message: 'Display connected — waiting for compositor',
            });
        });

        it('keeps the KMS-direct path on hosts without waylandsink installed', () => {
            listMock.mockReturnValue([connected('HDMI-A-1')]);
            firstMock.mockReturnValue('HDMI-A-1');
            pickMock.mockReturnValue(choice('HDMI-A-1', 32));
            const target = resolveRenderTarget('', { wayland: false, kms: true });
            expect(target.kind).toBe('ready');
            if (target.kind !== 'ready') return;
            expect(target.waylandFullscreen).toBe(false);
            expect(target.sinkEnv).toEqual({
                wayland: false,
                kms: true,
                waylandSession: false,
                connectorId: 32,
            });
        });
    });

    describe('resolveRenderTarget — ready', () => {
        it('carries the connector id and session state through to sink selection', () => {
            withCompositor();
            listMock.mockReturnValue([connected('DSI-2')]);
            pickMock.mockReturnValue(choice('DSI-2', 41));
            const target = resolveRenderTarget('DSI-2', { wayland: true, kms: true });
            if (target.kind !== 'ready') throw new Error('expected a ready target');
            expect(target.waylandFullscreen).toBe(true);
            expect(target.renderConnector).toBe('DSI-2');
            // kiosk-shell pins the surface by app_id to the output's app-ids=.
            expect(target.env).toEqual({ MR_GLIB_PRGNAME: 'local.mr.DSI-2' });
        });

        it('surfaces the substitution flag rather than hiding the swap', () => {
            listMock.mockReturnValue([disconnected('DSI-2'), connected('HDMI-A-1')]);
            firstMock.mockReturnValue('HDMI-A-1');
            pickMock.mockReturnValue(choice('HDMI-A-1', 32, true));
            const target = resolveRenderTarget('DSI-2', { wayland: false, kms: true });
            if (target.kind !== 'ready') throw new Error('expected a ready target');
            expect(target.active.substituted).toBe(true);
        });

        it('falls back to the first lit output when no display is configured', () => {
            // An unpinned surface is never mapped by kiosk-shell — the video is
            // simply absent. Field failure on a Pi 4, 2026-08-01.
            withCompositor();
            listMock.mockReturnValue([connected('HDMI-A-1')]);
            pickMock.mockReturnValue(choice('', undefined));
            firstMock.mockReturnValue('HDMI-A-1');
            const target = resolveRenderTarget('', { wayland: true, kms: true });
            if (target.kind !== 'ready') throw new Error('expected a ready target');
            expect(target.renderConnector).toBe('HDMI-A-1');
            expect(target.env).toEqual({ MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1' });
        });

        it('leaves the env empty on the KMS path — the app_id pin does not apply', () => {
            listMock.mockReturnValue([connected('HDMI-A-1')]);
            pickMock.mockReturnValue(choice('HDMI-A-1', 32));
            const target = resolveRenderTarget('HDMI-A-1', { wayland: false, kms: true });
            if (target.kind !== 'ready') throw new Error('expected a ready target');
            expect(target.env).toEqual({});
        });
    });

    describe('activeDisplayName', () => {
        it('uses the picked connector when there is one', () => {
            pickMock.mockReturnValue(choice('HDMI-A-1', 32));
            expect(activeDisplayName('HDMI-A-1')).toBe('HDMI-A-1');
        });

        it('falls back to the first lit output so the cog watch is not silently disabled', () => {
            pickMock.mockReturnValue(choice('', undefined));
            firstMock.mockReturnValue('HDMI-A-2');
            expect(activeDisplayName('')).toBe('HDMI-A-2');
        });

        it('returns an empty name when nothing is lit at all', () => {
            expect(activeDisplayName('')).toBe('');
        });
    });

    describe('resolveFallbackSurface', () => {
        it('sizes the card to the connector mode on the KMS path', () => {
            modeMock.mockReturnValue({ width: 1920, height: 1080 });
            expect(resolveFallbackSurface(UNLISTED_CONNECTOR, false)).toEqual({
                width: 1920,
                height: 1080,
            });
        });

        it('falls back to the default surface when the mode cannot be read', () => {
            modeMock.mockReturnValue(undefined);
            expect(resolveFallbackSurface(UNLISTED_CONNECTOR, false)).toEqual(DEFAULT_SURFACE);
        });

        it('goes through weston.ini on the compositor path (logical geometry)', () => {
            // No [output] section for this connector, so the compositor lookup
            // falls through to the kernel mode — but it IS the path taken.
            modeMock.mockReturnValue({ width: 1280, height: 720 });
            expect(resolveFallbackSurface(UNLISTED_CONNECTOR, true)).toEqual({
                width: 1280,
                height: 720,
            });
        });
    });

    describe('describeRenderPath', () => {
        it('reports the compositor path when a session is reachable', () => {
            withCompositor();
            pickMock.mockReturnValue(choice('DSI-2', 41));
            expect(describeRenderPath('DSI-2', { wayland: true, kms: true })).toEqual({
                renderer: 'waylandsink',
                target: 'DSI-2',
                status: 'compositor',
            });
        });

        it('reports the picked connector on the KMS path', () => {
            pickMock.mockReturnValue(choice('HDMI-A-1', 32));
            expect(describeRenderPath('HDMI-A-1', { wayland: false, kms: true })).toEqual({
                renderer: 'kmssink',
                target: 'HDMI-A-1',
                status: 'connected',
            });
        });

        it('reports the auto-picked connector when the user chose none', () => {
            listMock.mockReturnValue([disconnected('HDMI-A-1'), connected('HDMI-A-2')]);
            expect(describeRenderPath('', { wayland: false, kms: true })).toEqual({
                renderer: 'kmssink',
                target: 'HDMI-A-2',
                status: 'connected',
            });
        });

        it('reports "no display" when kmssink has nothing to drive', () => {
            listMock.mockReturnValue([disconnected('HDMI-A-1')]);
            expect(describeRenderPath('', { wayland: false, kms: true })).toEqual({
                renderer: 'kmssink',
                target: '(auto)',
                status: 'no display',
            });
        });

        it('reports autovideosink/unavailable on a host with no video sink at all', () => {
            expect(describeRenderPath('', { wayland: false, kms: false })).toEqual({
                renderer: 'autovideosink',
                target: '—',
                status: 'unavailable',
            });
        });

        it('adds `requested` only when a substitution actually happened', () => {
            pickMock.mockReturnValue(choice('HDMI-A-1', 32, true));
            expect(describeRenderPath('DSI-2', { wayland: false, kms: true })).toEqual({
                renderer: 'kmssink',
                target: 'HDMI-A-1',
                status: 'connected',
                requested: 'DSI-2',
            });
        });
    });
});

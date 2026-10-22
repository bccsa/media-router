import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { edidPreferredTiming, modeRefreshHz, resolveOutputRefreshHz } from './outputRefresh.js';

interface Dtd {
    clockMHz: number;
    h: number;
    hBlank: number;
    v: number;
    vBlank: number;
    interlaced?: boolean;
}

/** A 128-byte EDID base block whose first detailed timing descriptor is `t`. */
function edid(t: Dtd): Buffer {
    const b = Buffer.alloc(128);
    Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(b, 0);
    const clock = Math.round(t.clockMHz * 100); // 10 kHz units
    b.set(
        [
            clock & 0xff,
            clock >> 8,
            t.h & 0xff,
            t.hBlank & 0xff,
            ((t.h >> 8) << 4) | (t.hBlank >> 8),
            t.v & 0xff,
            t.vBlank & 0xff,
            ((t.v >> 8) << 4) | (t.vBlank >> 8),
        ],
        54,
    );
    if (t.interlaced) b[54 + 17] = 0x80;
    return b;
}

// CEA-861 timings: 1080p50 (VIC 31), 1080p60 (VIC 16), 1080i50 (VIC 20, per field).
const P1080_50: Dtd = { clockMHz: 148.5, h: 1920, hBlank: 720, v: 1080, vBlank: 45 };
const P1080_60: Dtd = { clockMHz: 148.5, h: 1920, hBlank: 280, v: 1080, vBlank: 45 };
const I1080_50: Dtd = {
    clockMHz: 74.25,
    h: 1920,
    hBlank: 720,
    v: 540,
    vBlank: 22,
    interlaced: true,
};

describe('modeRefreshHz', () => {
    it('reads the rate of a named mode and computes a modeline’s', () => {
        expect(modeRefreshHz('1920x1080@50')).toBe(50);
        expect(modeRefreshHz(' 1280x720@59.94 ')).toBe(59.94);
        // device-manager's formatModeline of CEA 1080p50.
        expect(modeRefreshHz('148.5 1920 2448 2492 2640 1080 1084 1089 1125 +hsync +vsync')).toBe(
            50,
        );
    });

    it('names no rate for preferred, a bare size or junk', () => {
        for (const m of ['preferred', 'current', '1920x1080', 'off', '1920x1080@0', 'x@y']) {
            expect(modeRefreshHz(m)).toBeUndefined();
        }
    });
});

describe('edidPreferredTiming', () => {
    it('reads the first detailed timing: size and refresh', () => {
        expect(edidPreferredTiming(edid(P1080_50))).toEqual({
            width: 1920,
            height: 1080,
            refreshHz: 50,
        });
        expect(edidPreferredTiming(edid(P1080_60))?.refreshHz).toBe(60);
        // Interlaced: per-field lines, so the frame is twice as tall and the rate is the field rate.
        expect(edidPreferredTiming(edid(I1080_50))).toEqual({
            width: 1920,
            height: 1080,
            refreshHz: 50.04,
        });
    });

    it('refuses what is not an EDID with a timing first', () => {
        expect(edidPreferredTiming(new Uint8Array(0))).toBeUndefined();
        expect(edidPreferredTiming(edid(P1080_50).subarray(0, 127))).toBeUndefined();
        const badHeader = edid(P1080_50);
        badHeader[0] = 0x01;
        expect(edidPreferredTiming(badHeader)).toBeUndefined();
        expect(edidPreferredTiming(edid({ ...P1080_50, clockMHz: 0 }))).toBeUndefined();
    });
});

describe('resolveOutputRefreshHz', () => {
    let root: string;
    let drmDir: string;
    let iniPath: string;
    /** One connected connector, with this EDID (an empty file: none read). */
    const connector = (name: string, data: Buffer) => {
        const dir = join(drmDir, `card1-${name}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'status'), 'connected\n');
        writeFileSync(join(dir, 'edid'), data);
    };
    const weston = (mode: string) =>
        writeFileSync(
            iniPath,
            `[core]\nshell=kiosk-shell.so\n\n[output]\nname=HDMI-A-1\nmode=${mode}\n`,
        );
    const resolve = (waylandFullscreen = true, name = 'HDMI-A-1') =>
        resolveOutputRefreshHz(name, waylandFullscreen, { iniPath, drmDir });

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'mr-refresh-'));
        drmDir = join(root, 'drm');
        iniPath = join(root, 'weston.ini');
        connector('HDMI-A-1', edid(P1080_60));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('through the compositor, the weston.ini mode wins: a rate or a modeline', () => {
        weston('1920x1080@50');
        expect(resolve()).toBe(50);
        weston('148.5 1920 2448 2492 2640 1080 1084 1089 1125 +hsync +vsync');
        expect(resolve()).toBe(50);
    });

    it('preferred, no output section or no weston.ini at all: the EDID preferred timing', () => {
        weston('preferred');
        expect(resolve()).toBe(60);
        writeFileSync(iniPath, '[output]\nname=DSI-1\nmode=800x480@60\n');
        expect(resolve()).toBe(60);
        rmSync(iniPath);
        expect(resolve()).toBe(60);
    });

    it('a bare size is the preferred mode when it is the preferred size, else unknown', () => {
        connector('HDMI-A-1', edid(P1080_50));
        weston('1920x1080');
        expect(resolve()).toBe(50);
        weston('1280x720');
        expect(resolve()).toBeUndefined();
    });

    it('without a compositor the sink keeps the connector mode: weston.ini does not apply', () => {
        weston('1920x1080@50');
        expect(resolve(false)).toBe(60);
    });

    it('unknown with no EDID (a DSI panel), or no such connector', () => {
        connector('DSI-1', Buffer.alloc(0));
        expect(resolve(true, 'DSI-1')).toBeUndefined();
        expect(resolve(true, 'HDMI-A-2')).toBeUndefined();
        expect(resolve(true, '')).toBeUndefined();
    });
});

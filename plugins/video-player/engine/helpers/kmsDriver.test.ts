import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kmsDriverFor } from './kmsDriver.js';

/**
 * A sysfs class dir as the kernel lays it out: `card<N>-<connector>/device` is the card,
 * `card<N>/device` the device bound to the driver (`driver`, a link to the driver's dir).
 */
function drmTree(root: string, cards: Record<string, { driver?: string; connector: string }>) {
    const cls = path.join(root, 'class', 'drm');
    fs.mkdirSync(cls, { recursive: true });
    for (const [card, c] of Object.entries(cards)) {
        const dev = path.join(root, 'devices', `${card}-dev`);
        const cardDir = path.join(dev, 'drm', card);
        const conn = path.join(cardDir, `${card}-${c.connector}`);
        fs.mkdirSync(conn, { recursive: true });
        fs.writeFileSync(path.join(conn, 'status'), 'connected\n');
        fs.symlinkSync(cardDir, path.join(conn, 'device'));
        fs.symlinkSync(dev, path.join(cardDir, 'device'));
        if (c.driver) {
            const drv = path.join(root, 'bus', 'platform', 'drivers', c.driver);
            fs.mkdirSync(drv, { recursive: true });
            fs.symlinkSync(drv, path.join(dev, 'driver'));
        }
        fs.symlinkSync(conn, path.join(cls, `${card}-${c.connector}`));
    }
    return cls;
}

describe('kmsDriverFor', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-kms-driver-'));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('names the Pi 5 box DSI panel driver, which kmssink never tries, and asks for full-screen frames', () => {
        // The Pi 5 box: vc4 drives the HDMI ports, drm-rp1-dsi the panel (DEV-P4a).
        const dir = drmTree(tmp, {
            card0: { driver: 'vc4-drm', connector: 'HDMI-A-1' },
            card1: { driver: 'drm-rp1-dsi', connector: 'DSI-2' },
        });
        expect(kmsDriverFor('DSI-2', dir)).toEqual({ name: 'drm-rp1-dsi', fullScreenOnly: true });
    });

    it("leaves a driver kmssink's own pick reaches to it, its platform name included", () => {
        const dir = drmTree(tmp, {
            card1: { driver: 'vc4-drm', connector: 'HDMI-A-1' },
            card2: { driver: 'i915', connector: 'DP-1' },
            card3: { driver: 'mxsfb', connector: 'DPI-1' },
            card4: { driver: 'stm32-display', connector: 'LVDS-1' },
        });
        for (const c of ['HDMI-A-1', 'DP-1', 'DPI-1', 'LVDS-1']) {
            expect(kmsDriverFor(c, dir), c).toBeUndefined();
        }
    });

    it('names any other driver as sysfs gives it, scaling allowed', () => {
        const dir = drmTree(tmp, { card0: { driver: 'vboxvideo', connector: 'Virtual-1' } });
        expect(kmsDriverFor('Virtual-1', dir)).toEqual({
            name: 'vboxvideo',
            fullScreenOnly: false,
        });
    });

    it('says nothing when sysfs does not: no connector, no driver link, no display picked', () => {
        const dir = drmTree(tmp, { card0: { connector: 'HDMI-A-1' } });
        expect(kmsDriverFor('HDMI-A-1', dir)).toBeUndefined();
        expect(kmsDriverFor('DSI-2', dir)).toBeUndefined();
        expect(kmsDriverFor('', dir)).toBeUndefined();
        expect(kmsDriverFor('DSI-2', path.join(tmp, 'nowhere'))).toBeUndefined();
    });
});

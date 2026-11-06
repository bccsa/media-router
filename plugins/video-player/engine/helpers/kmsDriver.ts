import * as fs from 'fs';
import * as path from 'path';
import { listDrmConnectors } from '@media-router/engine';

// The DRM driver kmssink must be told to open on the KMS path: without `driver-name` it opens the
// first of its own list that answers (gstkmssink.c `kms_open`), so a connector of another device,
// the Pi 5 box's DSI on drm-rp1-dsi, is never reached (DEV-P4a: it opened vc4).

/** kmssink's own list (`kms_open`), DRM driver names. */
const KMSSINK_PICKS = [
    'i915',
    'radeon',
    'nouveau',
    'vmwgfx',
    'exynos',
    'amdgpu',
    'imx-dcss',
    'imx-drm',
    'imx-lcdif',
    'rockchip',
    'atmel-hlcdc',
    'msm',
    'xlnx',
    'vc4',
    'mediatek',
    'meson',
    'stm',
    'sun4i-drm',
    'mxsfb-drm',
    'tegra',
    'tidss',
    'xilinx_drm',
];

/** Drivers whose plane takes only the full screen: kmssink must not place a smaller frame. */
const FULL_SCREEN_ONLY = new Set(['drm-rp1-dsi']);

export interface KmsDriver {
    /** The driver's name, as kmssink's `driver-name` takes it. */
    name: string;
    /** Its plane takes only the full screen (`can-scale=false`: frames at the panel's size). */
    fullScreenOnly: boolean;
}

/** The driver to name for `connector`, or undefined when kmssink's own pick reaches it or
 *  sysfs does not say (a dev machine, a connector gone). */
export function kmsDriverFor(connector: string, drmDir?: string): KmsDriver | undefined {
    if (!connector) return undefined;
    const sysfs = listDrmConnectors(drmDir).find((c) => c.name === connector)?.meta?.sysfsPath;
    if (!sysfs) return undefined;
    let name: string;
    try {
        // <connector>/device is its card; the card's device is bound to the driver.
        name = path.basename(
            fs.realpathSync(path.join(String(sysfs), 'device', 'device', 'driver')),
        );
    } catch {
        return undefined;
    }
    // The list reaches it when a name and an entry share a prefix (vc4's platform driver is
    // `vc4-drm`): kmssink's own pick, as before.
    if (KMSSINK_PICKS.some((pick) => name.startsWith(pick) || pick.startsWith(name))) {
        return undefined;
    }
    return { name, fullScreenOnly: FULL_SCREEN_ONLY.has(name) };
}

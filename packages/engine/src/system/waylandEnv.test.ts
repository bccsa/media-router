import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWaylandEnv } from './waylandEnv.js';

describe('ensureWaylandEnv', () => {
    let runtime: string;
    const saved = {
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    };

    beforeEach(() => {
        runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-wl-'));
        delete process.env.WAYLAND_DISPLAY;
        process.env.XDG_RUNTIME_DIR = runtime;
    });

    afterEach(() => {
        fs.rmSync(runtime, { recursive: true, force: true });
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('seeds WAYLAND_DISPLAY from the first wayland-N socket in XDG_RUNTIME_DIR', () => {
        fs.writeFileSync(path.join(runtime, 'wayland-1'), '');
        ensureWaylandEnv();
        expect(process.env.WAYLAND_DISPLAY).toBe('wayland-1');
    });

    it('leaves WAYLAND_DISPLAY unset when the runtime dir has no compositor socket', () => {
        fs.writeFileSync(path.join(runtime, 'wayland-1.lock'), '');
        ensureWaylandEnv();
        expect(process.env.WAYLAND_DISPLAY).toBeUndefined();
    });

    it('never overrides an already-exported WAYLAND_DISPLAY', () => {
        fs.writeFileSync(path.join(runtime, 'wayland-1'), '');
        process.env.WAYLAND_DISPLAY = 'wayland-7';
        ensureWaylandEnv();
        expect(process.env.WAYLAND_DISPLAY).toBe('wayland-7');
    });
});

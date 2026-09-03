import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runnerEnv } from './runnerEnv.js';

describe('runnerEnv', () => {
    const saved: Record<string, string | undefined> = {};
    let runtimeDir: string;

    beforeEach(() => {
        for (const k of ['MALLOC_ARENA_MAX', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY']) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-env-'));
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        fs.rmSync(runtimeDir, { recursive: true, force: true });
    });

    it('caps glibc malloc arenas at 2 for the runner unless the operator set it', () => {
        expect(runnerEnv().MALLOC_ARENA_MAX).toBe('2');
        process.env.MALLOC_ARENA_MAX = '8';
        expect(runnerEnv().MALLOC_ARENA_MAX).toBe('8');
    });

    it('seeds WAYLAND_DISPLAY from the runtime dir at spawn time, in the copy only', () => {
        fs.writeFileSync(path.join(runtimeDir, 'wayland-1'), '');
        process.env.XDG_RUNTIME_DIR = runtimeDir;
        const env = runnerEnv();
        expect(env.WAYLAND_DISPLAY).toBe('wayland-1');
        // The engine's own env is untouched — a later spawn re-resolves, which
        // is how a compositor that comes up after the engine is picked up.
        expect(process.env.WAYLAND_DISPLAY).toBeUndefined();
    });

    it('carries the rest of the process env through unchanged', () => {
        process.env.GST_PLUGIN_FEATURE_RANK = 'v4l2slh265dec:0';
        expect(runnerEnv().GST_PLUGIN_FEATURE_RANK).toBe('v4l2slh265dec:0');
        delete process.env.GST_PLUGIN_FEATURE_RANK;
    });
});

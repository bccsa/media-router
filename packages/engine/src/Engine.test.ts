import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Engine } from './Engine.js';

/**
 * Construction-only tests — Engine.start() needs pw-link/GStreamer, but the
 * LCP init payload is wired at construction and must be testable without them.
 */
describe('Engine — LCP init payload', () => {
    let tmpDir: string;
    let engine: Engine;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
        engine = new Engine({
            profilesPath: path.join(tmpDir, 'profiles.json'),
            pluginsDir: tmpDir,
        });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reports module run state, not the engine-process _running flag', () => {
        // Fresh engine: no modules running
        expect(engine.lcpServer._getInitData!().engineRunning).toBe(false);

        // Regression guard: the process flag alone must NOT flip the payload.
        // The old code reported `_running` (true from boot to shutdown), so
        // every reconnecting LCP saw "running" while all modules were stopped.
        (engine as unknown as { _running: boolean })._running = true;
        expect(engine.lcpServer._getInitData!().engineRunning).toBe(false);

        // The run controller is the source of truth
        (engine.runController as unknown as { _running: boolean })._running = true;
        expect(engine.lcpServer._getInitData!().engineRunning).toBe(true);
    });
});

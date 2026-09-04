import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Engine, type EngineConfig } from './Engine.js';

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

/**
 * The engine-wide time-sync contract switch. Resolved once at construction and
 * handed to every module through the services bag, so a module can never see a
 * different answer than the engine it runs in.
 */
describe('Engine — time-sync contract flag', () => {
    let tmpDir: string;

    const makeEngine = (config: Partial<EngineConfig> = {}): Engine =>
        new Engine({
            profilesPath: path.join(tmpDir, 'profiles.json'),
            pluginsDir: tmpDir,
            ...config,
        });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
        delete process.env.MR_TIME_SYNC_CONTRACT;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.MR_TIME_SYNC_CONTRACT;
    });

    it('is on by default — the contract is the path the fleet runs', () => {
        expect(makeEngine().timeSyncContract).toBe(true);
    });

    it('turns off from the engine config', () => {
        expect(makeEngine({ timeSyncContract: false }).timeSyncContract).toBe(false);
    });

    it('turns on from the engine config', () => {
        expect(makeEngine({ timeSyncContract: true }).timeSyncContract).toBe(true);
    });

    it('MR_TIME_SYNC_CONTRACT=0 forces it off — the kill-switch', () => {
        // start-engine.js (shipped by the Yocto recipe) passes no such option,
        // so the env var is how the fleet kills this from the unit file when a
        // box needs the legacy clockSync path back.
        process.env.MR_TIME_SYNC_CONTRACT = '0';
        expect(makeEngine().timeSyncContract).toBe(false);
    });

    it('MR_TIME_SYNC_CONTRACT=1 forces it on', () => {
        process.env.MR_TIME_SYNC_CONTRACT = '1';
        expect(makeEngine().timeSyncContract).toBe(true);
    });

    it('ignores any other env value — falls through to the default', () => {
        process.env.MR_TIME_SYNC_CONTRACT = 'true';
        expect(makeEngine().timeSyncContract).toBe(true);
        process.env.MR_TIME_SYNC_CONTRACT = '';
        expect(makeEngine().timeSyncContract).toBe(true);
    });

    it('an explicit config value wins over the env var, both ways', () => {
        process.env.MR_TIME_SYNC_CONTRACT = '1';
        expect(makeEngine({ timeSyncContract: false }).timeSyncContract).toBe(false);
        process.env.MR_TIME_SYNC_CONTRACT = '0';
        expect(makeEngine({ timeSyncContract: true }).timeSyncContract).toBe(true);
    });
});

/**
 * The engine-wide default playout offset D (ADR-0005 decision 4). Same
 * precedence shape as the contract flag above and resolved in the same place,
 * so every module on the box starts from one number and a route can only move
 * off it deliberately (via its route head's override).
 */
describe('Engine — default playout offset', () => {
    let tmpDir: string;

    const makeEngine = (config: Partial<EngineConfig> = {}): Engine =>
        new Engine({
            profilesPath: path.join(tmpDir, 'profiles.json'),
            pluginsDir: tmpDir,
            ...config,
        });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
        delete process.env.MR_PLAYOUT_OFFSET_MS;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete process.env.MR_PLAYOUT_OFFSET_MS;
    });

    it('defaults to 60 ms', () => {
        expect(makeEngine().playoutOffsetMs).toBe(60);
    });

    it('takes an explicit engine config value, including 0', () => {
        expect(makeEngine({ playoutOffsetMs: 450 }).playoutOffsetMs).toBe(450);
        expect(makeEngine({ playoutOffsetMs: 0 }).playoutOffsetMs).toBe(0);
    });

    it('MR_PLAYOUT_OFFSET_MS retunes the fleet from the unit file', () => {
        // start-engine.js passes no such option, so the env var is the only way
        // to move the budget without a code change — same pattern as
        // MR_TIME_SYNC_CONTRACT.
        process.env.MR_PLAYOUT_OFFSET_MS = '450';
        expect(makeEngine().playoutOffsetMs).toBe(450);
    });

    it('an explicit config value wins over the env var', () => {
        process.env.MR_PLAYOUT_OFFSET_MS = '450';
        expect(makeEngine({ playoutOffsetMs: 200 }).playoutOffsetMs).toBe(200);
    });

    it('ignores an unusable env value and falls through to the default', () => {
        for (const bad of ['', 'soon', '-1', '99999']) {
            process.env.MR_PLAYOUT_OFFSET_MS = bad;
            expect(makeEngine().playoutOffsetMs).toBe(60);
        }
    });
});

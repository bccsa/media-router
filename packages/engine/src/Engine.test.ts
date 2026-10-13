import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Engine, type EngineConfig } from './Engine.js';

/** Stand-in for the house clock: the test decides when the start wait ends. */
const { FakeHouseClock } = vi.hoisted(() => {
    // vi.mock factories are hoisted above the imports, so the class must be too.
    const { EventEmitter } = require('events') as typeof import('events');
    class FakeHouseClock extends EventEmitter {
        started = vi.fn();
        release!: (e: null) => void;
        private readonly gate = new Promise<null>((r) => (this.release = r));
        start(): void {
            this.started();
        }
        async stop(): Promise<void> {}
        ready(): Promise<null> {
            return this.gate;
        }
        epoch(): null {
            return null;
        }
        state() {
            return { source: 'none', waitingForSync: true, waitRemainingS: 21, epochSeq: 0 };
        }
    }
    return { FakeHouseClock };
});
type FakeHouseClock = InstanceType<typeof FakeHouseClock>;
vi.mock('./clock/HouseClock.js', () => ({ HouseClock: FakeHouseClock }));
// start() checks host tools; the start-wait test only needs it to get past them.
vi.mock('./audio/PwLinkOps.js', async (orig) => ({
    ...(await orig<typeof import('./audio/PwLinkOps.js')>()),
    requirePwLink: async () => {},
}));
vi.mock('./plugins/gstInspect.js', async (orig) => ({
    ...(await orig<typeof import('./plugins/gstInspect.js')>()),
    probeGstElement: async () => true,
}));

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
 * The engine-wide default playout offset D (ADR-0005 decision 4), resolved
 * once at construction so every module on the box starts from one number and
 * a route can only move off it deliberately (via its route head's override).
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
        // to move the budget without a code change.
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

/** The house-clock start wait (design §10.3): modules wait for the epoch; the engine's API, UI
 *  and manager link do not. */
describe('Engine — house-clock start wait', () => {
    let tmpDir: string;
    let engine: Engine;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
        engine = new Engine({
            profilesPath: path.join(tmpDir, 'profiles.json'),
            pluginsDir: tmpDir,
            apiPort: 0,
            localPort: 0,
        });
        vi.spyOn(engine.pipeWire, 'cleanupOrphans').mockResolvedValue();
    });

    afterEach(async () => {
        await engine.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('module start waits for ready(); the API answers during the wait', async () => {
        const clock = engine.houseClock as unknown as FakeHouseClock;
        const load = vi.spyOn(engine.pluginLoader, 'load');
        const lifecycle = (engine as unknown as { lifecycle: { startAll: () => Promise<void> } })
            .lifecycle;
        const startAll = vi.spyOn(lifecycle, 'startAll').mockResolvedValue();

        await engine.start(); // must not block on the clock
        expect(clock.started).toHaveBeenCalledOnce();
        // The 30 s wait runs from engine start, ahead of plugin load.
        expect(clock.started.mock.invocationCallOrder[0]).toBeLessThan(
            load.mock.invocationCallOrder[0],
        );

        const pending = engine.startModules();
        await new Promise((r) => setTimeout(r, 20));
        expect(engine.runController.isRunning).toBe(true);
        expect(startAll).not.toHaveBeenCalled();

        const api = (engine as unknown as { apiServer: { server: { address(): AddressInfo } } })
            .apiServer;
        const res = await fetch(`http://127.0.0.1:${api.server.address().port}/api/v1/health`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { status: string }).status).toBe('ok');

        clock.release(null);
        await pending;
        expect(startAll).toHaveBeenCalledOnce();
    });

    it('reports the time-sync state in every system stats sample', () => {
        const send = vi.spyOn(engine.managerConnection, 'send').mockImplementation(() => true);
        const collector = (
            engine as unknown as {
                systemStats: { onStats: (s: Record<string, unknown>) => void };
            }
        ).systemStats;
        collector.onStats({ cpu: 1, mem: 2, temp: null });
        expect(send).toHaveBeenCalledWith(
            'system',
            expect.objectContaining({
                timeSync: expect.objectContaining({ waitingForSync: true, waitRemainingS: 21 }),
            }),
        );
    });
});

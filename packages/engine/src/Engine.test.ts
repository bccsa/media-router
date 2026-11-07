import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { Engine } from './Engine.js';
import { GstInspectTimeoutError } from './plugins/gstInspect.js';

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
const { probeGstElement } = vi.hoisted(() => ({ probeGstElement: vi.fn(async () => true) }));
vi.mock('./plugins/gstInspect.js', async (orig) => ({
    ...(await orig<typeof import('./plugins/gstInspect.js')>()),
    probeGstElement,
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

/** B-199: named before any child starts, so no pactl or runner autospawns a PulseAudio daemon. */
describe('Engine — the PulseAudio server of its clients', () => {
    const keys = ['PULSE_SERVER', 'PULSE_RUNTIME_PATH', 'XDG_RUNTIME_DIR'];
    const saved: Record<string, string | undefined> = {};
    let tmpDir: string;

    beforeEach(() => {
        for (const k of keys) saved[k] = process.env[k];
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
    });

    afterEach(() => {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is the user’s pipewire-pulse socket, in PULSE_SERVER from construction on', () => {
        delete process.env.PULSE_SERVER;
        delete process.env.PULSE_RUNTIME_PATH;
        process.env.XDG_RUNTIME_DIR = '/run/user/1001';
        new Engine({ profilesPath: path.join(tmpDir, 'profiles.json'), pluginsDir: tmpDir });
        expect(process.env.PULSE_SERVER).toBe('unix:/run/user/1001/pulse/native');
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

/** The bus check at start: a gst-inspect run that timed out is not a missing unixfdsrc (B-102). */
describe('Engine — the unixfdsrc check at start', () => {
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

    it('names the probe that timed out, and loads no plugin', async () => {
        probeGstElement.mockRejectedValueOnce(new GstInspectTimeoutError(['unixfdsrc']));
        const load = vi.spyOn(engine.pluginLoader, 'load');

        const err = (await engine.start().catch((e: unknown) => e)) as Error;
        expect(err.message).toMatch(/^gst-inspect-1\.0 unixfdsrc timed out after 30 s/);
        expect(err.message).not.toMatch(/not available/);
        expect(load).not.toHaveBeenCalled();
    });

    it('still says unixfdsrc is not available when gst-inspect says so', async () => {
        probeGstElement.mockResolvedValueOnce(false);
        await expect(engine.start()).rejects.toThrow('GStreamer unixfdsrc not available');
    });
});

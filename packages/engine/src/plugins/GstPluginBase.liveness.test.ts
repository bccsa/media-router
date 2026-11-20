import { describe, it, expect, vi, afterEach } from 'vitest';

// B-246 (F-6): a playing pipeline whose runner stops answering shows a warning; the next answer
// withdraws it and only it (ADR-0010 rule 2).
const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        isRunning = false;
        /** 'alive' answers, 'frozen' times out, 'relaunching' is not asked. */
        mode: 'alive' | 'frozen' | 'relaunching' = 'alive';
        asks = 0;
        private readonly handlers = new Map<string, Array<(data: unknown) => void>>();
        constructor() {
            FakeChildProcess.instances.push(this);
        }
        on(event: string, fn: (data: unknown) => void): this {
            this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
            return this;
        }
        emit(event: string, data?: unknown): void {
            for (const fn of this.handlers.get(event) ?? []) fn(data);
        }
        async start(): Promise<void> {
            this.isRunning = true;
        }
        async stop(): Promise<void> {
            this.isRunning = false;
        }
        async destroy(): Promise<void> {
            this.isRunning = false;
        }
        async updatePipelineDesc(): Promise<void> {}
        async getProperty(): Promise<unknown> {
            return undefined;
        }
        ping(timeoutMs: number): Promise<boolean | null> {
            this.asks++;
            if (this.mode === 'relaunching') return Promise.resolve(null);
            if (this.mode === 'alive') return Promise.resolve(true);
            return new Promise((r) =>
                setTimeout(() => r(this.mode === 'frozen' ? false : true), timeoutMs),
            );
        }
    }
    return { FakeChildProcess };
});

vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: h.FakeChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import { QUEUE_OVERRUN_EVENT } from './queueOverrun.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

class Player extends GstPluginBase {
    buildPipeline(): PipelineDescription {
        return { pipeline: 'videotestsrc ! queue name=vp_esq ! fakesink' };
    }
}

const NOT_ANSWERING = /^Pipeline not answering for \d+ s \(stalled or frozen\)$/;

async function playing() {
    vi.useFakeTimers();
    h.FakeChildProcess.instances = [];
    const m = new Player();
    await m.onInit({}, { instanceId: 'vp-1' } as unknown as ModuleServices);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (m as unknown as { log: unknown }).log = log;
    await m.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    return { m, child, log };
}

afterEach(() => vi.useRealTimers());

describe('GstPluginBase: a runner that stops answering (B-246)', () => {
    it('no answer for 11 s is a warning; the next answer clears it', async () => {
        const { m, child, log } = await playing();
        await vi.advanceTimersByTimeAsync(4000);
        child.mode = 'frozen';
        await vi.advanceTimersByTimeAsync(11_000);
        expect(m.getState().health).toBe('warning');
        expect(m.getState().error).toMatch(NOT_ANSWERING);
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ seconds: expect.any(Number) }),
            'Pipeline not answering (stalled or frozen)',
        );
        child.mode = 'alive';
        await vi.advanceTimersByTimeAsync(3010);
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        expect(log.info).toHaveBeenCalledWith(
            expect.objectContaining({ seconds: expect.any(Number) }),
            'Pipeline answering again',
        );
        await m.onStop();
    });

    it('an answering runner never warns, an hour long', async () => {
        const { m, child } = await playing();
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(child.asks).toBe(720);
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });

    it('a relaunch in progress is not asked and never warns', async () => {
        const { m, child } = await playing();
        child.mode = 'relaunching';
        await vi.advanceTimersByTimeAsync(60_000);
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });

    it('nothing is asked before PLAYING, after a pipeline state change or after a stop', async () => {
        vi.useFakeTimers();
        h.FakeChildProcess.instances = [];
        const m = new Player();
        await m.onInit({}, { instanceId: 'vp-1' } as unknown as ModuleServices);
        (m as unknown as { log: unknown }).log = {
            warn: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        };
        await m.onStart();
        const child = h.FakeChildProcess.instances[0]!;
        child.mode = 'frozen';
        await vi.advanceTimersByTimeAsync(30_000);
        expect(child.asks).toBe(0); // started, not yet playing
        child.emit('stateChange', { state: 'playing' });
        await vi.advanceTimersByTimeAsync(11_100); // 5 s to the first ask, 6 s to the second miss
        expect(m.getState().error).toMatch(NOT_ANSWERING);
        // The runner restarts the pipeline: the warning goes with the state change.
        child.emit('stateChange', { state: 'stopped' });
        expect(m.getState().error ?? '').not.toMatch(NOT_ANSWERING);
        const asked = child.asks;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(child.asks).toBe(asked);
        child.emit('stateChange', { state: 'playing' });
        await m.onStop();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(child.asks).toBe(asked);
        expect(m.getState().health).toBe('stopped');
    });

    it('another writer’s warning set meanwhile is not cleared by the answer', async () => {
        const { m, child } = await playing();
        child.mode = 'frozen';
        await vi.advanceTimersByTimeAsync(11_100); // 5 s to the first ask, 6 s to the second miss
        expect(m.getState().error).toMatch(NOT_ANSWERING);
        m.setHealth('warning', 'Input swap pending');
        child.mode = 'alive';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: 'Input swap pending' });
        await m.onStop();
    });

    it('it never stands over another writer’s warning or an error', async () => {
        const { m, child } = await playing();
        m.setHealth('warning', 'Input swap pending');
        child.mode = 'frozen';
        await vi.advanceTimersByTimeAsync(20_000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: 'Input swap pending' });
        m.setHealth('error', 'Decoder failed');
        await vi.advanceTimersByTimeAsync(20_000);
        expect(m.getState()).toMatchObject({ health: 'error', error: 'Decoder failed' });
        await m.onStop();
    });

    it('over the module’s own timing warning it stands, and gives it back on the answer', async () => {
        const { m, child } = await playing();
        child.emit('pluginEvent', {
            channel: QUEUE_OVERRUN_EVENT,
            payload: {
                element: 'vp_esq',
                input: null,
                leaky: 0,
                levelTimeMs: 5000,
                overruns: 40,
                ms: 10_000,
                totalOverruns: 40,
                ongoing: true,
            },
        });
        const held = m.getState().error;
        expect(held).toMatch(/^vp_esq holding/);
        child.mode = 'frozen';
        await vi.advanceTimersByTimeAsync(11_100); // 5 s to the first ask, 6 s to the second miss
        expect(m.getState().error).toMatch(NOT_ANSWERING);
        child.mode = 'alive';
        await vi.advanceTimersByTimeAsync(3010);
        expect(m.getState()).toMatchObject({ health: 'warning', error: held });
        await m.onStop();
    });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

// B-177 (G3-1): a queue episode reported open, then its runner dies and respawns: no closing report
// can come, so the new pipeline's PLAYING does not put the old `queue-full` text back.
const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        isRunning = false;
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

const open = {
    element: 'vp_esq',
    input: null,
    leaky: 0,
    levelTimeMs: 5000,
    overruns: 40,
    ms: 10_000,
    totalOverruns: 40,
    ongoing: true,
};
const HELD = 'vp_esq holding 5000 ms at capacity — nothing lost, the queues before it fill next';

afterEach(() => vi.useRealTimers());

describe('GstPluginBase: an open queue episode across a runner respawn (B-177)', () => {
    it.each(['stopped', 'error'])(
        'a %s state drops it; the respawned PLAYING is healthy',
        async (gone) => {
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
            child.emit('stateChange', { state: 'playing' });
            child.emit('pluginEvent', { channel: QUEUE_OVERRUN_EVENT, payload: open });
            expect(m.getState()).toMatchObject({ health: 'warning', error: HELD });
            child.emit('stateChange', { state: gone, kind: 'runner_exit' });
            child.emit('stateChange', { state: 'playing' });
            await vi.advanceTimersByTimeAsync(2000);
            expect(m.getState()).toMatchObject({ health: 'ok', error: null });
            await m.onStop();
        },
    );

    it('a closed episode keeps its 30 s across the respawn', async () => {
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
        child.emit('stateChange', { state: 'playing' });
        child.emit('pluginEvent', {
            channel: QUEUE_OVERRUN_EVENT,
            payload: { ...open, ongoing: false },
        });
        child.emit('stateChange', { state: 'stopped' });
        child.emit('stateChange', { state: 'playing' });
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: HELD });
        await m.onStop();
    });
});

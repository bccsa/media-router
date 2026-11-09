import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** B-197: the Audio Output (302M) wires its SilentOutputWatch: a mixer that delivers no audio
 *  says so, through the relaunch's PLAYING, and is relaunched once; one source played direct is
 *  not judged on it. Since B-167 nothing else says it: the sink plays what comes. */

const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        isRunning = false;
        pipelineLaunchedAt: number | undefined = undefined;
        readonly restartPipeline = vi.fn(async (_reason: string) => {});
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
            this.pipelineLaunchedAt = 1;
        }
        async stop(): Promise<void> {
            this.isRunning = false;
        }
        async destroy(): Promise<void> {
            this.isRunning = false;
        }
        async updatePipelineDesc(): Promise<void> {}
        async setProperty(): Promise<void> {}
    }
    return { FakeChildProcess };
});

vi.mock(
    '../../../packages/engine/src/child-process/GstChildProcess.js',
    async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        GstChildProcess: h.FakeChildProcess,
    }),
);

import { busSrcTapName, type ModuleServices } from '@media-router/engine';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

const source = (i: number) => ({
    port: 40100 + i,
    connectionId: `c-${i}`,
    sourceModuleId: `src-${i}`,
    sourcePortId: 'out-0',
    sinkPortId: 'audio-in',
    streamType: 'audio/302m',
    socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
});

async function started(sources: number, router: Record<string, unknown> = {}) {
    h.FakeChildProcess.instances = [];
    const module = new AudioOutput302mModule();
    await module.onInit({ device: 'alsa_output.usb-KTMicro' }, {
        instanceId: 'aout-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => Array.from({ length: sources }, (_, i) => source(i))),
            getModuleConnections: vi.fn(() => []),
            onProducerPlaying: vi.fn(),
            moduleName: (id: string) => `Module ${id}`,
            ...router,
        },
    } as unknown as ModuleServices);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (module as unknown as { log: unknown }).log = log;
    await module.onStart();
    const child = h.FakeChildProcess.instances.at(-1)!;
    child.emit('stateChange', { state: 'playing' });
    return { module, child, log };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Audio Output (302M) that plays nothing (B-197)', () => {
    it('its mixer delivers no audio: a warning, not ok, and one relaunch', async () => {
        const { module, child } = await started(2);
        child.emit('vuData', { peak: [-18, -18] });
        expect(module.getState().health).toBe('ok');
        await vi.advanceTimersByTimeAsync(8000);
        expect(module.getState()).toMatchObject({
            health: 'warning',
            error: 'Plays nothing: its mixer delivers no audio — relaunched',
        });
        expect(child.restartPipeline).toHaveBeenCalledTimes(1);
        // Audio again: the warning goes.
        for (let t = 0; t < 1500; t += 100) {
            child.emit('vuData', { peak: [-18, -18] });
            await vi.advanceTimersByTimeAsync(100);
        }
        expect(module.getState().health).toBe('ok');
        await module.onStop();
    });

    it("the relaunch's PLAYING keeps the warning while it still plays nothing, and no second relaunch", async () => {
        const { module, child } = await started(2);
        await vi.advanceTimersByTimeAsync(8000);
        expect(child.restartPipeline).toHaveBeenCalledTimes(1);
        // The relaunch plays (PLAYING resets health to ok); its mixer is still silent.
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState()).toMatchObject({
            health: 'warning',
            error: 'Plays nothing: its mixer delivers no audio — relaunched',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(module.getState().error).toBe(
            'Plays nothing: its mixer delivers no audio — relaunched',
        );
        expect(child.restartPipeline).toHaveBeenCalledTimes(1);
        await module.onStop();
    });

    it('B-167: no playout watch: a late report from the runner is no reason, the output plays on', async () => {
        const { module, child } = await started(2);
        child.emit('vuData', { peak: [-18, -18] });
        child.emit('pluginEvent', {
            channel: 'playout_watch',
            payload: { element: 'sink', playing: false, lateMs: 1555.3, budgetMs: 90 },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(module.getState().health).toBe('ok');
        expect(child.restartPipeline).not.toHaveBeenCalled();
        await module.onStop();
    });

    it("B-206: a launch that skipped its inputs' backlog says so in one INFO line, by producer", async () => {
        const { module, child, log } = await started(2);
        child.emit('pluginEvent', {
            channel: 'catch_up',
            payload: {
                inputs: [
                    { element: busSrcTapName(source(1)), skippedMs: 234.7, buffers: 11 },
                    { element: busSrcTapName(source(0)), skippedMs: 5220, buffers: 502 },
                ],
                skippedMs: 5220,
            },
        });
        // A launch that dropped one TS buffer (no span) logs nothing.
        child.emit('pluginEvent', {
            channel: 'catch_up',
            payload: {
                inputs: [{ element: busSrcTapName(source(0)), skippedMs: 0, buffers: 1 }],
                skippedMs: 0,
            },
        });
        const lines = log.info.mock.calls.filter((c) => String(c[1]).startsWith('Caught up'));
        expect(lines).toHaveLength(1);
        expect(lines[0][0]).toHaveProperty('catchUp');
        expect(lines[0][1]).toBe(
            'Caught up at the start: skipped 5.2 s of Module src-0, 235 ms of Module src-1 from ' +
                'before it played, never played late',
        );
        expect(module.getState().health).toBe('ok');
        await module.onStop();
    });

    it('B-167: what the mix queued before it first played is named as the mix, beside its inputs', async () => {
        const { module, child, log } = await started(2);
        child.emit('pluginEvent', {
            channel: 'catch_up',
            payload: {
                inputs: [
                    { element: busSrcTapName(source(0)), skippedMs: 7480, buffers: 360 },
                    { element: 'lat_render', skippedMs: 1890.4, buffers: 189 },
                ],
                skippedMs: 7480,
            },
        });
        const lines = log.info.mock.calls.filter((c) => String(c[1]).startsWith('Caught up'));
        expect(lines.map((c) => c[1])).toEqual([
            'Caught up at the start: skipped 7.5 s of Module src-0, 1.9 s of the mix from ' +
                'before it played, never played late',
        ]);
        await module.onStop();
    });

    it('one source played direct: what it queued before it first played is named as its source', async () => {
        const { module, child, log } = await started(1);
        child.emit('pluginEvent', {
            channel: 'catch_up',
            payload: {
                inputs: [{ element: 'lat_render', skippedMs: 384, buffers: 38 }],
                skippedMs: 384,
            },
        });
        const lines = log.info.mock.calls.filter((c) => String(c[1]).startsWith('Caught up'));
        expect(lines.map((c) => c[1])).toEqual([
            'Caught up at the start: skipped 384 ms of its source from before it played, never played late',
        ]);
        await module.onStop();
    });

    it('one source played direct: no audio is its source going quiet, not judged here', async () => {
        const { module, child } = await started(1);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(module.getState().health).toBe('ok');
        expect(child.restartPipeline).not.toHaveBeenCalled();
        await module.onStop();
    });
});

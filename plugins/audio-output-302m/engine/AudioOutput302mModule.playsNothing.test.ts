import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** B-197: the Audio Output (302M) wires its SilentOutputWatch: a mixer that delivers no audio
 *  says so, through the relaunch's PLAYING, and is relaunched once; one source played direct is
 *  not judged on it. */

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

import type { ModuleServices } from '@media-router/engine';
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

async function started(sources: number) {
    h.FakeChildProcess.instances = [];
    const module = new AudioOutput302mModule();
    await module.onInit({ device: 'alsa_output.usb-KTMicro' }, {
        instanceId: 'aout-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => Array.from({ length: sources }, (_, i) => source(i))),
            getModuleConnections: vi.fn(() => []),
            onProducerPlaying: vi.fn(),
        },
    } as unknown as ModuleServices);
    await module.onStart();
    const child = h.FakeChildProcess.instances.at(-1)!;
    child.emit('stateChange', { state: 'playing' });
    return { module, child };
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

    it('one source played direct: no audio is its source going quiet, not judged here', async () => {
        const { module, child } = await started(1);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(module.getState().health).toBe('ok');
        expect(child.restartPipeline).not.toHaveBeenCalled();
        await module.onStop();
    });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The lateness display (WI-P0-9) lives in the base class: `mrlateness:<tap>`
 * events never reach a subclass, the timing sections survive a subclass
 * replacing its own dynamic sections, and stop clears them.
 */
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
        async getProperty(_el: string, prop: string): Promise<unknown> {
            return prop === 'ts-offset' ? 60_000_000 : 100_000;
        }
    }
    return { FakeChildProcess };
});

vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: h.FakeChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import { buildBusSrc } from './busHelpers.js';
import { withLatenessTap } from './latenessTap.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

class OutputModule extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription {
        return {
            pipeline: `${buildBusSrc({ name: 'busin', port: 41000 })} ! ${withLatenessTap('lat_render', 'pulsesink name=sink')}`,
            timingSink: { element: 'sink', kind: 'audio' },
        };
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
    replaceSections(): void {
        this.setDynamicSections([{ id: 'peers', label: 'Peers', fields: [] }]);
    }
}

const win = (meanMs: number) => ({
    count: 50,
    'min-ns': meanMs * 1e6,
    'mean-ns': meanMs * 1e6,
    'max-ns': meanMs * 1e6,
});

afterEach(() => vi.useRealTimers());

describe('GstPluginBase timing section', () => {
    it('turns runner lateness windows into the timing section and badge', async () => {
        vi.useFakeTimers();
        h.FakeChildProcess.instances = [];
        const m = new OutputModule();
        await m.onInit({}, { instanceId: 'dec-1' } as unknown as ModuleServices);
        await m.onStart();
        const child = h.FakeChildProcess.instances[0]!;
        child.emit('stateChange', { state: 'playing' });
        await vi.advanceTimersByTimeAsync(0);
        child.emit('pluginEvent', { channel: 'mrlateness:lat_busin', payload: win(5) });
        child.emit('pluginEvent', { channel: 'mrlateness:lat_render', payload: win(20) });
        child.emit('pluginEvent', { channel: 'level:lvl', payload: {} });
        await vi.advanceTimersByTimeAsync(2000);

        expect(m.seen).toEqual(['level:lvl']);
        m.replaceSections();
        const state = m.getState();
        expect(state.dynamicStatusSections!.map((s) => s.id)).toEqual([
            'peers',
            'timing',
            'timing-in-1',
        ]);
        expect(state.statusData!.timing).toMatchObject({
            outputMs: 20,
            decodeMs: 15,
            presentationDelayMs: 60,
            deviceLatencyMs: 100,
            renderMs: 160,
        });
        expect(state.badges).toContainEqual(
            expect.objectContaining({ id: 'lateness', text: '160 ms' }),
        );

        await m.onStop();
        expect(m.getState().dynamicStatusSections).toEqual([]);
        expect(m.getState().badges).toEqual([]);
    });
});

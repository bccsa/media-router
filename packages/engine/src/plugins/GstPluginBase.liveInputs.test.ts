import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * B-192: a live-input aggregator launched without some of its inputs (`liveInputs`, their
 * producers not there) runs without them and says so by producer, until each joins; what it
 * runs without is set anew at every launch, so a stale name never comes back.
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
        async updatePipelineDesc(): Promise<void> {}
    }
    return { FakeChildProcess };
});

vi.mock('../child-process/GstChildProcess.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../child-process/GstChildProcess.js')>()),
    GstChildProcess: h.FakeChildProcess,
}));

import { GstPluginBase } from './GstPluginBase.js';
import type { LiveInputBranch, ModuleServices, PipelineDescription } from './PluginModule.js';

let wired: string[] = [];

class Aggregator extends GstPluginBase {
    getLiveInputBranch(_port: string, connectionId: string): LiveInputBranch | null {
        const name = `mixin_in_${connectionId}`;
        return wired.includes(connectionId)
            ? { element: 'mixin', name, description: `unixfdsrc socket-path=/tmp/${connectionId}` }
            : { element: 'mixin', name };
    }
    buildPipeline(): PipelineDescription | null {
        const liveInputs = wired.map((c) => this.getLiveInputBranch('audio-in', c)!);
        this.setHealth('ok');
        return { pipeline: 'audiomixer name=mixin ! fakesink', liveInputs };
    }
}

const source = (c: string) => ({
    port: 41000,
    connectionId: c,
    sourceModuleId: `src-${c}`,
    sourcePortId: 'out-0',
    sinkPortId: 'audio-in',
    streamType: 'audio/302m',
    socketPath: `/tmp/${c}`,
});

async function started() {
    h.FakeChildProcess.instances = [];
    const module = new Aggregator();
    await module.onInit({}, {
        instanceId: 'aout-1',
        mediaRouter: {
            getModuleBusSources: () => wired.map(source),
            getModuleConnections: () =>
                wired.map((c) => ({ ...source(c), id: c, sinkModuleId: 'aout-1' })),
            onProducerPlaying: vi.fn(),
        },
    } as unknown as ModuleServices);
    await module.onStart();
    return { module, child: h.FakeChildProcess.instances.at(-1)! };
}

const LOST_23 = 'Input from src-c2 (audio-in), src-c3 (audio-in) lost — continuing without it';

beforeEach(() => {
    wired = ['c0', 'c1', 'c2', 'c3'];
});

describe('GstPluginBase — a launch without some live inputs (B-192)', () => {
    it('warns by producer at the gate opening, and the warning stands through PLAYING', async () => {
        const { module, child } = await started();
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2', 'mixin_in_c3'] });
        expect(module.getState().error).toBe(LOST_23);
        expect(module.isLiveInputLost('mixin_in_c2')).toBe(true);
        expect(module.isLiveInputLost('mixin_in_c0')).toBe(false);
        child.emit('stateChange', { state: 'playing' });
        expect(module.getState().running).toBe(true);
        expect(module.getState().health).toBe('warning');
        expect(module.getState().error).toBe(LOST_23);
    });

    it('a join narrows it and the last one clears it', async () => {
        const { module, child } = await started();
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2', 'mixin_in_c3'] });
        module.noteLiveInputRestored('mixin_in_c2');
        expect(module.getState().error).toBe(
            'Input from src-c3 (audio-in) lost — continuing without it',
        );
        module.noteLiveInputRestored('mixin_in_c3');
        expect(module.getState().health).toBe('ok');
        expect(module.isLiveInputLost('mixin_in_c3')).toBe(false);
    });

    it('each launch sets it anew: a relaunch with every input clears it, a data wait does not', async () => {
        const { module, child } = await started();
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2', 'mixin_in_c3'] });
        child.emit('busGate', { pending: [] }); // the data wait's clearing names nothing
        expect(module.getState().error).toBe(LOST_23);
        child.emit('busGate', { pending: [], absent: [] });
        expect(module.getState().health).toBe('ok');
        expect(module.isLiveInputLost('mixin_in_c2')).toBe(false);
    });

    it('an error stands over it', async () => {
        const { module, child } = await started();
        child.emit('error', { message: 'Bus ERROR: pulsesink: device busy' });
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2'] });
        expect(module.getState().health).toBe('error');
        expect(module.isLiveInputLost('mixin_in_c2')).toBe(true);
    });

    it('an input unwired while it is missing takes its name out at the description refresh', async () => {
        const { module, child } = await started();
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2', 'mixin_in_c3'] });
        wired = ['c0', 'c1', 'c2'];
        await module.refreshPipelineDescription();
        expect(module.getState().error).toBe(
            'Input from src-c2 (audio-in) lost — continuing without it',
        );
        expect(module.isLiveInputLost('mixin_in_c3')).toBe(false);
    });

    it('a fresh start forgets what the last run went without', async () => {
        const { module, child } = await started();
        child.emit('busGate', { pending: [], absent: ['mixin_in_c2'] });
        await module.onStop();
        await module.onStart();
        expect(module.isLiveInputLost('mixin_in_c2')).toBe(false);
        h.FakeChildProcess.instances.at(-1)!.emit('stateChange', { state: 'playing' });
        expect(module.getState().health).toBe('ok');
    });
});

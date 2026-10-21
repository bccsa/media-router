import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plan ch. 3 part 4.5 rule 6 (WI-S0-8): a runner that cannot use libgstmrtshouse.so starts the
 * module on stand-ins and warns. The module carries the alarm until a start loads the plugin,
 * and a module whose demux has no stand-in fails with the same text.
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
            const list = this.handlers.get(event) ?? [];
            list.push(fn);
            this.handlers.set(event, list);
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
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

// The plan's sentence, literally: a change to the text is a change to rule 6.
const RULE6 =
    'Native TS module not loaded: this stream carries no house time on the bus; consumers will mis-time it until the deploy is fixed.';
const STALE =
    'libgstmrtshouse.so abi 0 < 1: /opt/media-router/plugins/mpegts-core/native/mrtshouse/libgstmrtshouse.so';
const MISSING = 'libgstmrtshouse.so not loaded, tried /a/libgstmrtshouse.so, /b/libgstmrtshouse.so';
const LOADED = {
    version: '1.0.0',
    abi: 1,
    path: '/usr/libexec/media-router/mpegts-core/libgstmrtshouse.so',
};

class TestModule extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return { pipeline: 'audiotestsrc ! mrtsrestamp name=restamp ! fakesink' };
    }
    /** What a subclass recovering from its own fault does. */
    recovered(): void {
        this.setHealth('ok');
    }
}

type Child = InstanceType<typeof h.FakeChildProcess>;

async function start(module: TestModule): Promise<Child> {
    await module.onStart();
    return h.FakeChildProcess.instances.at(-1)!;
}

async function makeStarted(): Promise<{ module: TestModule; child: Child }> {
    h.FakeChildProcess.instances = [];
    const module = new TestModule();
    await module.onInit({}, { instanceId: 'ingest-1' } as unknown as ModuleServices);
    const child = await start(module);
    expect(module.getState().health).toBe('ok');
    return { module, child };
}

const health = (m: TestModule): { health: string; error: string | null } => {
    const s = m.getState();
    return { health: s.health, error: s.error ?? null };
};

beforeEach(() => vi.clearAllMocks());

describe('GstPluginBase — the timing plugin alarm (plan ch. 3 rule 6)', () => {
    it("the runner's warning raises the rule-6 text, and PLAYING keeps it", async () => {
        const { module, child } = await makeStarted();
        child.emit('timingPlugin', { detail: STALE });
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${STALE})` });
        child.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${STALE})` });
    });

    it('other warnings come and go over it; every return to ok shows it again', async () => {
        const { module, child } = await makeStarted();
        child.emit('timingPlugin', { detail: MISSING });
        child.emit('busGate', { pending: ['/tmp/mr-bus-41000-x.sock'] });
        expect(module.getState().error).toContain('Waiting for upstream module(s)');
        child.emit('busGate', { pending: [] });
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${MISSING})` });
        child.emit('inputSilent', { message: 'UDP source netsrc silent' });
        child.emit('inputResumed', {});
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${MISSING})` });
        module.recovered();
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${MISSING})` });
        // A real fault still shows as itself.
        child.emit('error', { message: 'Bus ERROR: not-linked' });
        expect(health(module)).toEqual({ health: 'error', error: 'Bus ERROR: not-linked' });
        child.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${MISSING})` });
    });

    it('it stays across a restart until a start loads the plugin, which clears it', async () => {
        const { module, child } = await makeStarted();
        child.emit('timingPlugin', { detail: STALE });
        await module.onStop();
        expect(module.getState().health).toBe('stopped');
        const next = await start(module);
        // Nothing has loaded the plugin since: the alarm stands until a start says so.
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${STALE})` });
        next.emit('timingPlugin', { loaded: LOADED });
        expect(health(module)).toEqual({ health: 'ok', error: null });
        next.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'ok', error: null });
        module.recovered();
        expect(health(module)).toEqual({ health: 'ok', error: null });
    });

    it('a start that still cannot use it shows its own specifics', async () => {
        const { module, child } = await makeStarted();
        child.emit('timingPlugin', { detail: STALE });
        await module.onStop();
        const next = await start(module);
        next.emit('timingPlugin', { detail: MISSING });
        next.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'warning', error: `${RULE6} (${MISSING})` });
    });

    it("the runner's error (a demux with no stand-in) fails the module with that text", async () => {
        const { module, child } = await makeStarted();
        const detail = `${MISSING}; mrtsdemux has no stand-in`;
        // The engine fixes the text, whatever wording the runner logged.
        child.emit('error', { kind: 'timing_plugin', message: 'runner wording', detail });
        child.emit('stateChange', { state: 'error', kind: 'timing_plugin' });
        expect(health(module)).toEqual({ health: 'error', error: `${RULE6} (${detail})` });
        // The runner's next attempt warns before it is refused again: the error stands.
        child.emit('timingPlugin', { detail: MISSING });
        expect(health(module)).toEqual({ health: 'error', error: `${RULE6} (${detail})` });
        // Fixed on a later attempt: the load clears the alarm and PLAYING the error.
        child.emit('timingPlugin', { loaded: LOADED });
        child.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'ok', error: null });
    });

    it('a plugin row not required (kind native_plugin) is no rule-6 alarm: its own text', async () => {
        // libgstmrducker.so (WI-P2-10): the module cannot run, the bus's house time is fine.
        const { module, child } = await makeStarted();
        const message =
            'Native plugin not loaded: this module needs it and cannot run until the deploy is ' +
            'fixed. (libgstmrducker.so not loaded, tried /a, /b; mrptskeep has no stand-in)';
        child.emit('error', { kind: 'native_plugin', message, detail: 'x' });
        child.emit('stateChange', { state: 'error', kind: 'native_plugin' });
        expect(health(module)).toEqual({ health: 'error', error: message });
        // Nothing stands once a start runs: no alarm comes back on PLAYING.
        child.emit('stateChange', { state: 'playing' });
        expect(health(module)).toEqual({ health: 'ok', error: null });
    });
});

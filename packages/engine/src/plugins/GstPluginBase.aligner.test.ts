import { describe, it, expect, vi, afterEach } from 'vitest';

// The aligners' warnings (house-clock WI-P2-13) live in the base class: `mralignwatch:<name>`
// reports from the runner become the `input-absent` and `aligner-full` health warnings, which
// never override another writer's text, and the reports never reach a subclass.
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
import { busEdgeSocketPath } from './busHelpers.js';
import type { AlignerInputRef, AlignerWatchRef } from './alignerWatches.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

const MS = 1_000_000;
const CONN_A = 'enc-a:out-mix:audio-in';
const CONN_B = 'enc-b:out-mix:audio-in';
const SOURCES = [
    { port: 41000, connectionId: CONN_A, sourceModuleId: 'enc-a' },
    { port: 41001, connectionId: CONN_B, sourceModuleId: 'enc-b' },
].map((s) => ({
    ...s,
    sourcePortId: 'out',
    sinkPortId: 'audio-in',
    streamType: 'audio/302m',
    socketPath: busEdgeSocketPath(s.port, s.connectionId),
}));

class Mixer extends GstPluginBase {
    seen: string[] = [];
    own: ((w: AlignerWatchRef) => AlignerInputRef | undefined) | null = null;
    buildPipeline(): PipelineDescription {
        this.setHealth('ok');
        return { pipeline: 'unixfdsrc socket-path=/tmp/x.sock ! fakesink' };
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
    protected alignerInputOf(w: AlignerWatchRef): AlignerInputRef | undefined {
        return this.own ? this.own(w) : super.alignerInputOf(w);
    }
}

const report = (
    input: string,
    state: 'waiting' | 'present' | 'absent',
    o: { reason?: string; full?: number; levelMs?: number } = {},
) => ({
    reason: o.reason ?? 'state',
    aligner: 'mixin',
    input,
    state,
    lateness: 20 * MS,
    pace: 20 * MS,
    'silence-limit': 240 * MS,
    absences: state === 'absent' ? 1 : 0,
    'stale-buffers': 0,
    'stale-time': 0,
    gaps: 0,
    'level-time': (o.levelMs ?? 0) * MS,
    'level-bytes': 0,
    'full-count': o.full ?? 0,
});

async function started(): Promise<{ m: Mixer; child: InstanceType<typeof h.FakeChildProcess> }> {
    h.FakeChildProcess.instances = [];
    const m = new Mixer();
    await m.onInit({}, {
        instanceId: 'mix-1',
        mediaRouter: { getModuleBusSources: () => SOURCES, onProducerPlaying: () => {} },
    } as unknown as ModuleServices);
    await m.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    return { m, child };
}

const send = (child: InstanceType<typeof h.FakeChildProcess>, name: string, payload: object) =>
    child.emit('pluginEvent', { channel: `mralignwatch:${name}`, payload });

const ABSENT_B = 'Input enc-b (audio-in) silent for 240 ms — continuing without it';

afterEach(() => vi.useRealTimers());

describe('GstPluginBase aligner warnings', () => {
    it('input-absent: raised from the runner report, cleared on return; no subclass sees it', async () => {
        const { m, child } = await started();
        send(child, 'mixin_aw_a', report(CONN_A, 'present'));
        send(child, 'mixin_aw_b', report(CONN_B, 'absent'));
        expect(m.getState()).toMatchObject({ health: 'warning', error: ABSENT_B });
        expect(m.getState().statusData!['timing-in-2']).toMatchObject({ state: 'absent' });
        expect(m.getState().statusData!.timing).toMatchObject({ waitingFor: 'enc-b (audio-in)' });
        send(child, 'mixin_aw_b', report(CONN_B, 'present'));
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        expect(m.seen).toEqual([]);
        await m.onStop();
    });

    it('never over another warning or an error; takes over once that clears', async () => {
        vi.useFakeTimers();
        const { m, child } = await started();
        child.emit('inputSilent', { message: 'UDP source silent' });
        send(child, 'mixin_aw_b', report(CONN_B, 'absent'));
        expect(m.getState().error).toBe('UDP source silent');
        child.emit('inputResumed', {});
        expect(m.getState().health).toBe('ok');
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: ABSENT_B });
        child.emit('error', { message: 'pipeline failed' });
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'error', error: 'pipeline failed' });
        // Its own return cannot clear someone else's text.
        send(child, 'mixin_aw_b', report(CONN_B, 'present'));
        expect(m.getState()).toMatchObject({ health: 'error', error: 'pipeline failed' });
        await m.onStop();
    });

    it('aligner-full joins the text and outlives the absent input', async () => {
        const { m, child } = await started();
        send(child, 'mixin_aw_b', report(CONN_B, 'absent'));
        send(
            child,
            'mixin_aw_a',
            report(CONN_A, 'present', { reason: 'full', full: 1, levelMs: 5000 }),
        );
        const full = 'Input enc-a (audio-in) queue full — upstream held';
        expect(m.getState().error).toBe(`${ABSENT_B}; ${full}`);
        send(child, 'mixin_aw_b', report(CONN_B, 'present'));
        expect(m.getState()).toMatchObject({ health: 'warning', error: full });
        send(
            child,
            'mixin_aw_a',
            report(CONN_A, 'present', { reason: 'interval', full: 1, levelMs: 100 }),
        );
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });

    it('a description refresh or PLAYING resets health; the warning comes straight back', async () => {
        const { m, child } = await started();
        send(child, 'mixin_aw_b', report(CONN_B, 'absent'));
        await m.refreshPipelineDescription();
        expect(m.getState()).toMatchObject({ health: 'warning', error: ABSENT_B });
        child.emit('stateChange', { state: 'playing' });
        expect(m.getState()).toMatchObject({ health: 'warning', error: ABSENT_B });
        await m.onStop();
        expect(m.getState().health).toBe('stopped');
    });

    it("a module's resolver names its own inputs", async () => {
        const { m, child } = await started();
        m.own = (w) => (w.input === 'demux_1_audio' ? { label: 'Input 2' } : undefined);
        send(child, 'aw_demux_1_audio', report('demux_1_audio', 'absent'));
        expect(m.getState().error).toBe('Input Input 2 silent for 240 ms — continuing without it');
        await m.onStop();
    });

    it('getTimingSummary is the summary last published, none after a stop', async () => {
        const { m, child } = await started();
        child.emit('pluginEvent', {
            channel: 'mrlateness:lat_busout_42000',
            payload: { count: 10, 'mean-ns': 33 * MS, 'min-ns': 30 * MS, 'max-ns': 36 * MS },
        });
        send(child, 'mixin_aw_a', report(CONN_A, 'present'));
        expect(m.getTimingSummary()?.output).toEqual({ meanMs: 33, minMs: 30, maxMs: 36 });
        await m.onStop();
        expect(m.getTimingSummary()).toBeUndefined();
    });
});

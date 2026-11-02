import { describe, it, expect, vi, afterEach } from 'vitest';

// B-203 (MR-033): an output 10 s or more off the house clock is the module's warning while it lasts,
// one health text with the aligners' (WI-P2-13), never over another writer's; an egress stamp
// guard's episode (`stamp_off_clock`) is one WARN line in the module's log.
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
import { STAMP_OFF_CLOCK_EVENT } from './offClock.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

const MS = 1_000_000;
const CONN_B = 'enc-b:out-mix:audio-in';
const SOURCES = [{ port: 41001, connectionId: CONN_B, sourceModuleId: 'enc-b' }].map((s) => ({
    ...s,
    sourcePortId: 'out',
    sinkPortId: 'audio-in',
    streamType: 'audio/302m',
    socketPath: busEdgeSocketPath(s.port, s.connectionId),
}));

class Producer extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription {
        this.setHealth('ok');
        return { pipeline: 'unixfdsrc socket-path=/tmp/x.sock ! tee name=busout_40000 ! fakesink' };
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
}

const win = (meanMs: number) => ({
    count: 100,
    untimed: 0,
    'min-ns': meanMs * MS,
    'mean-ns': meanMs * MS,
    'max-ns': meanMs * MS,
    'last-ns': meanMs * MS,
    'interval-ns': 2000 * MS,
    reference: 'running-time',
});

async function started(): Promise<{
    m: Producer;
    child: InstanceType<typeof h.FakeChildProcess>;
    log: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}> {
    h.FakeChildProcess.instances = [];
    const m = new Producer();
    await m.onInit({}, {
        instanceId: 'srt-in-1',
        mediaRouter: { getModuleBusSources: () => SOURCES, onProducerPlaying: () => {} },
    } as unknown as ModuleServices);
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (m as unknown as { log: unknown }).log = log;
    await m.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    return { m, child, log };
}

const egress = (child: InstanceType<typeof h.FakeChildProcess>, meanMs: number) =>
    child.emit('pluginEvent', { channel: 'mrlateness:lat_busout_40000', payload: win(meanMs) });

const OFF_4H = 'Output timing off the house clock by 4 h 22 min (ahead)';

afterEach(() => vi.useRealTimers());

describe('GstPluginBase: an output off the house clock (B-203)', () => {
    it('a warning while the output reads 10 s or more off, ok once it is back', async () => {
        vi.useFakeTimers();
        const { m, child } = await started();
        egress(child, 60);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'ok' });
        egress(child, -15_742_882);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: OFF_4H });
        egress(child, -15_740_882);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: OFF_4H });
        egress(child, 62);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        expect(m.seen).toEqual([]);
        await m.onStop();
    });

    it('one text with an aligner warning; never over another writer; back once that clears', async () => {
        vi.useFakeTimers();
        const { m, child } = await started();
        egress(child, -12_000);
        child.emit('pluginEvent', {
            channel: 'mralignwatch:mixin_aw_b',
            payload: {
                reason: 'state',
                aligner: 'mixin',
                input: CONN_B,
                state: 'absent',
                lateness: 20 * MS,
                pace: 20 * MS,
                'silence-limit': 240 * MS,
                absences: 1,
                'stale-buffers': 0,
                'stale-time': 0,
                gaps: 0,
                'level-time': 0,
                'level-bytes': 0,
                'full-count': 0,
            },
        });
        await vi.advanceTimersByTimeAsync(2000);
        const absent = 'Input enc-b (audio-in) silent for 240 ms — continuing without it';
        const off = 'Output timing off the house clock by 12.0 s (ahead)';
        expect(m.getState()).toMatchObject({ health: 'warning', error: `${absent}; ${off}` });
        child.emit('inputSilent', { message: 'UDP source silent' });
        egress(child, -12_000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState().error).toBe('UDP source silent');
        child.emit('inputResumed', {});
        egress(child, -12_000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState()).toMatchObject({ health: 'warning', error: `${absent}; ${off}` });
        await m.onStop();
    });

    it('a stamp guard episode is one WARN line naming the egress; the subclass still sees it', async () => {
        const { m, child, log } = await started();
        const pes = { tee: 'busout_40000', pid: 0x101, offsetMs: 15_742_882.9, count: 1 };
        child.emit('pluginEvent', { channel: STAMP_OFF_CLOCK_EVENT, payload: pes });
        expect(log.warn).toHaveBeenCalledWith(
            { stampOffClock: pes },
            'Bus egress busout_40000: a timing PES on PID 0x101 read 4 h 22 min ahead of the house clock, so it ' +
                'timed nothing (1 so far)',
        );
        const floor = { tee: 'busout_40000', pid: -1, offsetMs: 25_000, count: 2 };
        child.emit('pluginEvent', { channel: STAMP_OFF_CLOCK_EVENT, payload: floor });
        expect(log.warn).toHaveBeenLastCalledWith(
            { stampOffClock: floor },
            'Bus egress busout_40000: its stamp was 25.0 s ahead of the house clock, reset to house time',
        );
        // A payload without fields is still one line, naming no egress.
        child.emit('pluginEvent', { channel: STAMP_OFF_CLOCK_EVENT, payload: null });
        expect(log.warn).toHaveBeenCalledTimes(3);
        expect(log.warn.mock.calls[2][1]).toMatch(/^Bus egress \?: /);
        expect(m.seen).toEqual([
            STAMP_OFF_CLOCK_EVENT,
            STAMP_OFF_CLOCK_EVENT,
            STAMP_OFF_CLOCK_EVENT,
        ]);
        await m.onStop();
    });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * FF9 recovery (timelineSettleRestart.ts), driven through the real GstPluginBase wiring:
 * runner events in, relaunches of this module's own pipeline out.
 */
const h = vi.hoisted(() => {
    class FakeChildProcess {
        static instances: FakeChildProcess[] = [];
        static launches = 0;
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
            this.pipelineLaunchedAt = ++FakeChildProcess.launches;
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

type FakeChild = InstanceType<typeof h.FakeChildProcess>;

/** 2026-10-14 07:20:00Z — journal times below are ms after it. */
const T0 = Date.UTC(2026, 9, 14, 7, 20, 0);
const VU_EVERY_MS = 100;

const implausible = (excessBeforeMs: number) => ({
    channel: 'backlog_shed',
    payload: { element: 'sink', outcome: 'implausible', budgetMs: 580, excessBeforeMs },
});
const rebase = (latenessMs: number, padOffsetNs: number, count: number) => ({
    channel: 'playout_reanchor',
    payload: {
        kind: 'rebase',
        element: 'sink',
        latenessMs,
        appliedOffsetNs: Math.round(latenessMs * 1e6),
        padOffsetNs,
        flushed: false,
        sanityMs: 10000,
        budgetMs: 580,
        count,
    },
});
const RAISE = {
    channel: 'playout_reanchor',
    payload: {
        kind: 'raise',
        element: 'sink',
        excessMs: 112,
        worstMs: 171,
        cause: 'timeline',
        queuedMs: 0,
        budgetMs: 580,
        tsOffsetMs: 400,
        latencyMs: 180,
        holdMs: 15000,
    },
};

/** `contract: false` = the engine's legacy services: no `timeSyncContract` key at all. */
async function start302m({ contract = true }: { contract?: boolean } = {}) {
    h.FakeChildProcess.instances = [];
    const sources = [
        {
            port: 40100,
            connectionId: 'c-0',
            sourceModuleId: 'audio-transcoder-1',
            sourcePortId: 'out-0',
            sinkPortId: 'audio-in',
            streamType: 'audio/302m',
            socketPath: '/tmp/mr-bus-40100-x.sock',
        },
    ];
    const router = {
        getModuleBusSources: vi.fn(() => sources),
        getRoutePlayoutOffsetMs: vi.fn(() => undefined),
        getRoutePlayoutHead: vi.fn(() => ({ headId: 'splitter-1', label: 'TS Splitter' })),
        getRoutePlayoutRaiseMs: vi.fn(() => 0),
        requestPlayoutRaise: vi.fn(async () => 'raised'),
        notePlayoutRebase: vi.fn(),
        onProducerPlaying: vi.fn(),
    };
    const module = new AudioOutput302mModule();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await module.onInit({ device: 'alsa_output.usb-KTMicro' }, {
        instanceId: 'aout-1',
        ...(contract ? { timeSyncContract: true } : {}),
        playoutReanchor: true,
        playoutOffsetMs: 500,
        mediaRouter: router,
    } as unknown as ModuleServices);
    (module as unknown as { log: unknown }).log = log;
    await module.onStart();
    const child: FakeChild = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    /** ms after T0 of every relaunch; each one is a fresh launch, PLAYING 300 ms later. */
    const relaunches: number[] = [];
    child.restartPipeline.mockImplementation(async () => {
        relaunches.push(Date.now() - T0);
        child.pipelineLaunchedAt = ++h.FakeChildProcess.launches;
        setTimeout(() => child.emit('stateChange', { state: 'playing' }), 300);
    });
    const at = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(Math.max(0, T0 + ms - Date.now()));
    };
    /** VU readings every 100 ms over [fromMs, toMs): the source is flowing. */
    const flow = async (fromMs: number, toMs: number) => {
        for (let t = fromMs; t < toMs; t += VU_EVERY_MS) {
            await at(t);
            child.emit('vuData', { peak: [-18, -18] });
        }
        await at(toMs);
    };
    const deliver = (ev: { channel: string; payload: unknown }) => child.emit('pluginEvent', ev);
    return { module, child, log, router, relaunches, at, flow, deliver };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('AudioOutput302mModule — FF9 settle relaunch', () => {
    it('replays its own 07:20Z on .108 (implausible, then the bus-stall resume): one relaunch', async () => {
        const { child, log, router, relaunches, flow, at, deliver } = await start302m();
        await flow(0, 6_558); // VU stalls 07:20:09.716 with gapMs 3158
        await at(17_759);
        deliver(implausible(10613.8));
        await flow(17_760, 97_000); // "VU meter resumed" gapMs 11202; 07:21:37 = next episode
        expect(relaunches).toEqual([27_760]);
        expect(router.notePlayoutRebase).not.toHaveBeenCalled(); // this leg never rebased
        expect(child.restartPipeline).toHaveBeenCalledWith(
            'source timeline settled after a bus-stall resume',
        );
        expect(h.FakeChildProcess.instances).toHaveLength(1); // its own pipeline, not a rebuild
        expect(log.warn).toHaveBeenCalledWith(
            { trigger: 'bus-stall resume' },
            'Source timeline settled after a bus-stall resume — relaunching this pipeline once',
        );
    });

    it('replays the decoder leg’s 07:20Z rebase sequence: exactly one relaunch', async () => {
        const { router, relaunches, flow, at, deliver } = await start302m();
        await flow(0, 6_906);
        await at(17_711);
        deliver(implausible(10711));
        await at(17_744);
        deliver(rebase(-11365.7, -11365702983, 1));
        await at(17_755);
        deliver(implausible(10917.4));
        await flow(17_757, 77_807);
        deliver(rebase(11035.3, -330374753, 2)); // inside the 60 s window
        await flow(77_807, 97_000);
        expect(relaunches).toEqual([27_757]);
        // The route head still hears both rebases ("rebased this output"), the dropped #2 too.
        const note = (ms: number) => expect.objectContaining({ element: 'sink', latenessMs: ms });
        expect(router.notePlayoutRebase.mock.calls).toEqual([
            ['aout-1', undefined, note(-11365.7)],
            ['aout-1', undefined, note(11035.3)],
        ]);
    });

    it('no relaunch on a clean run, including VU gaps shorter than a stall', async () => {
        const { relaunches, flow } = await start302m();
        await flow(0, 100_000); // last reading at 99.9 s
        await flow(104_800, 300_000); // a 4.9 s gap: shorter than a 5 s bus stall
        expect(relaunches).toEqual([]);
    });

    it('no relaunch on an ordinary re-anchor: raises, a lone implausible report, a runner respawn', async () => {
        // In the code a rebase exists only past the 10 s sanity ceiling; under it the leg asks
        // for a raise. The producer's own re-anchors never reach the leg as events.
        const { child, relaunches, flow, deliver } = await start302m();
        await flow(0, 20_000);
        deliver(RAISE);
        await flow(20_000, 50_000);
        deliver(RAISE);
        await flow(50_000, 80_000);
        deliver(implausible(10400));
        await flow(80_000, 100_000);
        // Runner-internal respawn: a 10 s VU gap across a NEW launch is not a bus-stall resume.
        child.pipelineLaunchedAt = ++h.FakeChildProcess.launches;
        child.emit('stateChange', { state: 'playing' });
        await flow(110_000, 200_000);
        expect(relaunches).toEqual([]);
    });

    it('a raise neither arms nor postpones a pending relaunch', async () => {
        const { relaunches, flow, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 6_000);
        deliver(RAISE);
        await flow(6_000, 30_000);
        expect(relaunches).toEqual([11_000]);
    });

    it('an implausible report while pending restarts the quiet period', async () => {
        const { relaunches, flow, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 6_000);
        deliver(implausible(10917.4));
        await flow(6_000, 30_000);
        expect(relaunches).toEqual([16_000]);
    });

    it('a bus-stall resume alone arms it: relaunch 10 s after the source comes back', async () => {
        const { relaunches, flow } = await start302m();
        await flow(0, 10_000);
        await flow(15_000, 40_000); // a 5.1 s stall, same launch
        expect(relaunches).toEqual([25_000]);
    });

    it('contract off: no relaunch on a long VU gap (a legacy sink is sync=false, no shedder)', async () => {
        const { log, relaunches, flow } = await start302m({ contract: false });
        await flow(0, 6_558);
        await flow(17_760, 100_000); // the 07:20Z resume gap, ~11.2 s
        expect(log.info).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('unsettled'),
        );
        expect(relaunches).toEqual([]);
    });

    it('a source that is silent at the deadline has not settled: it waits for it', async () => {
        const { relaunches, flow, at, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 2_000);
        await at(25_000); // silent from 2 s: the 11 s deadline passes without a relaunch
        expect(relaunches).toEqual([]);
        await flow(25_000, 60_000); // back at 25 s: a stall-resume, so 10 s more
        expect(relaunches).toEqual([35_000]);
    });

    it('a cleared meter (no peaks) is not a VU reading, so it cannot read as a resume', async () => {
        // DeviceWatchdog's onClear zeroes the meter just before a disconnect stops the pipeline.
        const { module, log, relaunches, flow, at } = await start302m();
        await flow(0, 10_000);
        await at(20_000); // a stall-length gap: as a reading, it would be a resume
        (module as unknown as { setVuData(d: number[]): void }).setVuData([]);
        await at(40_000);
        expect(log.info).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('unsettled'),
        );
        expect(relaunches).toEqual([]);
    });

    it('at most one relaunch per 60 s: a trigger inside the window is dropped, a later one counts', async () => {
        const { relaunches, flow, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 70_000); // relaunch at 11 s
        deliver(rebase(11035.3, -330374753, 2)); // 59 s after it: dropped
        await flow(70_000, 72_000);
        deliver(rebase(-11264, -11594401142, 3)); // 61 s after it: counts
        await flow(72_000, 200_000);
        expect(relaunches).toEqual([11_000, 82_000]);
    });

    it('a dropped trigger is never deferred, so a persisting condition cannot loop', async () => {
        const { relaunches, flow, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 13_000); // relaunch at 11 s
        deliver(rebase(-11264, -11594401142, 1)); // the fresh pipeline rebases at once
        await flow(13_000, 300_000);
        expect(relaunches).toEqual([11_000]);
    });

    it('a fresh pipeline (any PLAYING edge) cancels the pending relaunch', async () => {
        const { child, relaunches, flow, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await flow(1_000, 4_000);
        child.pipelineLaunchedAt = ++h.FakeChildProcess.launches; // runner crash-restart
        child.emit('stateChange', { state: 'playing' });
        await flow(4_000, 30_000);
        expect(relaunches).toEqual([]);
    });

    it('stopping during the quiet period cancels the timer', async () => {
        const { module, relaunches, flow, at, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await at(5_000);
        await module.onStop();
        expect(vi.getTimerCount()).toBe(0);
        await at(60_000);
        expect(relaunches).toEqual([]);
    });

    it('a device unplug during the quiet period cancels the timer', async () => {
        const { module, relaunches, flow, at, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        await at(5_000);
        await (
            module as unknown as { onDeviceDisconnected(): Promise<void> }
        ).onDeviceDisconnected();
        expect(vi.getTimerCount()).toBe(0);
        await at(60_000);
        expect(relaunches).toEqual([]);
    });

    it('destroying during the quiet period cancels the timer, even with the runner down', async () => {
        const { module, child, relaunches, flow, at, deliver } = await start302m();
        await flow(0, 1_000);
        deliver(rebase(-11365.7, -11365702983, 1));
        child.emit('stateChange', { state: 'stopped' }); // GstPluginBase.onDestroy skips onStop
        await at(5_000);
        await module.onDestroy();
        expect(vi.getTimerCount()).toBe(0);
        await at(60_000);
        expect(relaunches).toEqual([]);
    });
});

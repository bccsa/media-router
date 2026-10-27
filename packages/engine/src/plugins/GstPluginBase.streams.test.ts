import { describe, it, expect, vi, afterEach } from 'vitest';

// The demuxes' and consumer ASRCs' warnings (house-clock WI-P3-6) live in the base class with the
// aligners': one health text owned by the module, never over another writer's; `mrtsdemux` is
// the base class's alone, `mrasrc-*` reach the subclass too (an ingest's card reads its own).
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
import type { DemuxInputRef } from './demuxWatches.js';
import type { PipelineDescription, ModuleServices } from './PluginModule.js';

const MS = 1_000_000;
const CONN = 'srt-1:out:mpegts-in';
const SUB = 'ttx-1:out:subtitles-in';
const SOURCES = [
    { port: 41000, connectionId: CONN, sourceModuleId: 'srt-1', sinkPortId: 'mpegts-in' },
    { port: 41001, connectionId: SUB, sourceModuleId: 'ttx-1', sinkPortId: 'subtitles-in' },
].map((s) => ({
    ...s,
    sourcePortId: 'out',
    streamType: 'muxed/mpegts',
    socketPath: busEdgeSocketPath(s.port, s.connectionId),
}));

class Consumer extends GstPluginBase {
    seen: string[] = [];
    buildPipeline(): PipelineDescription {
        this.setHealth('ok');
        return {
            pipeline:
                'unixfdsrc socket-path=/tmp/x.sock ! mrtsdemux name=demux media=audio' +
                ' ! avdec_aac ! audioconvert ! mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink' +
                ' ! pulsesink name=sink slave-method=custom',
        };
    }
    protected onPluginEvent(channel: string): void {
        this.seen.push(channel);
    }
    protected demuxInputOf(element: string): DemuxInputRef | undefined {
        if (element === 'subdemux') return { port: 'subtitles-in' };
        return element === 'demux' ? { port: 'mpegts-in' } : undefined;
    }
}

async function started(): Promise<{ m: Consumer; child: InstanceType<typeof h.FakeChildProcess> }> {
    h.FakeChildProcess.instances = [];
    const m = new Consumer();
    await m.onInit({}, {
        instanceId: 'dec-1',
        mediaRouter: { getModuleBusSources: () => SOURCES, onProducerPlaying: () => {} },
    } as unknown as ModuleServices);
    await m.onStart();
    const child = h.FakeChildProcess.instances[0]!;
    child.emit('stateChange', { state: 'playing' });
    return { m, child };
}

const send = (child: InstanceType<typeof h.FakeChildProcess>, channel: string, payload: object) =>
    child.emit('pluginEvent', { channel, payload });
const absent = (input: string) => ({
    reason: 'state',
    aligner: 'mixin',
    input,
    state: 'absent',
    lateness: 0,
    pace: 0,
    'silence-limit': 240 * MS,
    absences: 1,
    'stale-time': 0,
    'level-time': 0,
    'level-bytes': 0,
    'full-count': 0,
});

const NOT_HOUSE =
    'Input srt-1 (mpegts-in) is 7200 s off house time — its producer does not stamp house time';

afterEach(() => vi.useRealTimers());

describe('GstPluginBase demux and ASRC warnings', () => {
    it('raised from the runner message, cleared at the next program; no subclass sees mrtsdemux', async () => {
        const { m, child } = await started();
        send(child, 'mrtsdemux:demux', { reason: 'program', generation: 0, pads: 'audio_0_0101' });
        send(child, 'mrtsdemux:demux', {
            reason: 'not-house-time',
            pid: 0x101,
            'offset-ms': -7_200_000,
        });
        expect(m.getState()).toMatchObject({ health: 'warning', error: NOT_HOUSE });
        send(child, 'mrtsdemux:demux', { reason: 'program', generation: 1, pads: 'audio_1_0101' });
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        expect(m.seen).toEqual([]);
        await m.onStop();
    });

    it("no-stream names the demux's media; it goes when the stream is found", async () => {
        const { m, child } = await started();
        send(child, 'mrtsdemux:demux', { reason: 'no-stream', stream: 'missing' });
        expect(m.getState().error).toBe('Input srt-1 (mpegts-in) carries no audio stream');
        send(child, 'mrtsdemux:demux', {
            reason: 'interval',
            stream: 'found',
            pes: 3,
            generation: 1,
        });
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });

    it("one text with the aligners'; never over another writer; back after PLAYING", async () => {
        vi.useFakeTimers();
        const { m, child } = await started();
        send(child, 'mralignwatch:mixin_aw_sub', absent(SUB));
        send(child, 'mrtsdemux:demux', {
            reason: 'not-house-time',
            pid: 0x101,
            'offset-ms': 7_200_000,
        });
        const both = `Input ttx-1 (subtitles-in) silent for 240 ms — continuing without it; ${NOT_HOUSE}`;
        expect(m.getState().error).toBe(both);
        child.emit('stateChange', { state: 'playing' });
        expect(m.getState()).toMatchObject({ health: 'warning', error: both });
        child.emit('inputSilent', { message: 'UDP source silent' });
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState().error).toBe('UDP source silent');
        child.emit('inputResumed', {});
        await vi.advanceTimersByTimeAsync(2000);
        expect(m.getState().error).toBe(both);
        await m.onStop();
        expect(m.getState()).toMatchObject({ health: 'stopped' });
    });

    it("an ASRC's messages reach the subclass; its out-of-bounds warns until it is back", async () => {
        const { m, child } = await started();
        const stats = (ppb: number) => ({
            mode: 'decode+device',
            state: 'locked',
            relocks: 0,
            'in-frames': 10,
            'source-ppb': ppb,
            'device-ppb': -12_100,
        });
        send(child, 'mrasrc-stats:asrc', stats(1_300_000));
        send(child, 'mrasrc-event:asrc', { kind: 'ratio-out-of-bounds', 'fit-ppb': -1_298_312 });
        expect(m.seen).toEqual(['mrasrc-stats:asrc', 'mrasrc-event:asrc']);
        expect(m.getState()).toMatchObject({
            health: 'warning',
            error:
                "Source clock +1300.0 ppm off house time, past the ASRC's 1000 ppm — check the source's" +
                ' sample rate',
        });
        send(child, 'mrasrc-stats:asrc', stats(20_000));
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });

    it('a start begins with none standing', async () => {
        const { m, child } = await started();
        send(child, 'mrtsdemux:demux', { reason: 'no-stream', stream: 'missing' });
        expect(m.getState().health).toBe('warning');
        await m.onStop();
        await m.onStart();
        expect(m.getState()).toMatchObject({ health: 'ok', error: null });
        await m.onStop();
    });
});

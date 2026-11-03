import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-195, the Audio Output (302M) on a real PipeWire: a private daemon with a virtual sink, the
 *  real module on the native runner, a 302M tone from a runner off PipeWire (only the output's
 *  recovery is timed). Skipped, saying why, without PipeWire, an element, the plugin or runner. */

import {
    GstChildProcess,
    ModuleInstance,
    PipeWireManager,
    buildBusSink,
    busEdgeSocketPath,
    busTeeName,
} from '@media-router/engine';
import { build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
import { setLogTap } from '@media-router/shared-types';
import {
    PrivatePipeWire,
    linkPlaybackStreams,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';

const SINK = 'c18_spk';
const PORT = 41951;
const CONN = 'b195-tone';
const ELEMENTS = [
    'pulsesink',
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
    'level',
    'capssetter',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');

/** Never the user's registry: the gate's own, or one of this run's. */
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b195o-registry-${process.pid}.bin`);

const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip) console.warn(`[B-195] real PipeWire restart test (302M output) skipped — ${skip}`);
});

describe.skipIf(skip !== null)(
    'Audio Output (302M) on a real PipeWire that restarts (B-195)',
    { timeout: 120_000 },
    () => {
        let pw: PrivatePipeWire;
        let producer: GstChildProcess;
        let instance: ModuleInstance;
        let module: AudioOutput302mModule;
        let stopLinking: () => Promise<void>;
        let savedBusDir: string | undefined;
        const lines: Array<{ time: string; name: string; msg: string }> = [];
        const state = () => module.getState();
        /** The sink RUNNING with a stream (a sink-input) on it: the output plays into it. */
        const playing = async () => {
            const sinks = await pw.tool('pactl', ['list', 'short', 'sinks']);
            const sink = sinks.split('\n').find((l) => l.split('\t')[1] === SINK);
            if (!sink || !/\tRUNNING$/.test(sink)) return false;
            const inputs = await pw.tool('pactl', ['list', 'short', 'sink-inputs']);
            return inputs.split('\n').some((l) => l.split('\t')[1] === sink.split('\t')[0]);
        };
        /** Health ok and the stream playing into the sink, within `budgetMs`. */
        const playsAgain = async (budgetMs: number) => {
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
                if (state().health === 'ok' && (await playing())) return true;
                await sleep(100);
            }
            return false;
        };

        beforeAll(async () => {
            pw = new PrivatePipeWire({ sinks: [SINK] });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap((l) => lines.push(JSON.parse(l)));
            await pw.start();
            stopLinking = linkPlaybackStreams(pw, SINK);

            // A 302M source off PipeWire: a tone, encoded and published on the bus as modules do.
            producer = new GstChildProcess();
            const producerPlaying = new Promise<void>((resolve) =>
                producer.on('stateChange', (d: { state: string }) => {
                    if (d.state === 'playing') resolve();
                }),
            );
            await producer.start({
                pipeline:
                    'audiotestsrc is-live=true wave=sine volume=0.2' +
                    ' ! audio/x-raw,rate=48000,channels=2' +
                    ` ! ${build302mEncodeBranch()} ! ${buildBusSink(PORT)}`,
            });
            await producerPlaying;
            const edge = busEdgeSocketPath(PORT, CONN);
            producer.sendBusAttach(busTeeName(PORT), edge);
            expect(await until(() => existsSync(edge), 10_000)).toBe(true);

            module = new AudioOutput302mModule();
            instance = new ModuleInstance(
                'b195-out',
                'audio-output-302m',
                module,
                { device: SINK, channels: 2 },
                {
                    instanceId: 'b195-out',
                    pipeWire: new PipeWireManager(),
                    mediaRouter: {
                        assignBusChannel: () => ({ port: 41952 }),
                        releaseAllBusChannelsFor: () => {},
                        onProducerPlaying: () => {},
                        getModuleBusSources: () => [
                            {
                                port: PORT,
                                socketPath: edge,
                                connectionId: CONN,
                                sinkPortId: 'audio-in',
                                sourceChannels: 2,
                            },
                        ],
                        hasStoredEdge: () => false,
                    },
                    processManager: { releaseAll: async () => {} },
                    deviceProviders: {},
                } as any,
            );
            await instance.start();
            expect(await playsAgain(60_000)).toBe(true);
        }, 120_000);

        afterAll(async () => {
            await instance?.stop();
            await producer?.destroy();
            await stopLinking?.();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b195o-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        /** The runner host's own restarts (`[gst-runner] Restarting pipeline in …`) since `spy`. */
        const runnerRestarts = (spy: { mock: { calls: unknown[][] } }) =>
            spy.mock.calls.filter((c) => String(c[0]).startsWith('[gst-runner] Restarting'));

        it('restarted under the sink (~0.2 s down): a warning, never an error, then playing again within 10 s', async () => {
            const health: string[] = [];
            const onHealth = () => health.push(state().health);
            module.on('stateChange', onHealth);
            const stderr = vi.spyOn(console, 'error');
            await pw.stop();
            await sleep(200);
            await pw.start();
            const back = Date.now();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            expect(state().error).toMatch(/^PipeWire (restarted|stream failed)/);
            expect(await playsAgain(10_000)).toBe(true);
            const ms = Date.now() - back;
            console.log(
                `[B-195] 302M output, restart: playing again ${ms} ms after PipeWire returned`,
            );
            expect(ms).toBeLessThan(10_000);
            module.off('stateChange', onHealth);
            expect(health).not.toContain('error');
            expect(lines.map((l) => l.msg)).toContain('PipeWire stream rebuilt');
            // The module rebuilt it; the runner did not restart it (the field's 816 ms restart).
            expect(runnerRestarts(stderr)).toEqual([]);
            stderr.mockRestore();
        });

        it('down over 15 s: one teardown, no runner restart, no log line but the outage warning, playing again within 10 s of the return', async () => {
            const starts = vi.spyOn(GstChildProcess.prototype, 'start');
            const stderr = vi.spyOn(console, 'error');
            await pw.stop();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            expect(state().error).toMatch(/^PipeWire (is not answering|stream failed)/);
            const quiet = lines.length;
            await sleep(15_000);
            expect(starts).not.toHaveBeenCalled();
            expect(runnerRestarts(stderr)).toEqual([]);
            stderr.mockRestore();
            // At most the outage's one warning, from the first device listing that gets no answer.
            const outage = 'AudioDeviceOps: PipeWire does not answer pactl';
            const during = lines.slice(quiet).map((l) => `${l.name}: ${l.msg}`);
            expect(during.filter((t) => !t.startsWith(outage))).toEqual([]);
            expect(during.length).toBeLessThanOrEqual(1);
            await pw.start();
            const back = Date.now();
            expect(await playsAgain(10_000)).toBe(true);
            const ms = Date.now() - back;
            console.log(
                `[B-195] 302M output, outage: playing again ${ms} ms after PipeWire returned`,
            );
            expect(ms).toBeLessThan(10_000);
            expect(starts).toHaveBeenCalledTimes(1);
            starts.mockRestore();
        });
    },
);

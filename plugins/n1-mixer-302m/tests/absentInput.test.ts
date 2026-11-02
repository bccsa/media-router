import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-197 on the native runner: an N-1 Audio Mixer (302M) launched while one input's only
 *  producer is down starts with the others (it waited for every input's socket); that input
 *  joins when its producer plays. Skipped, saying why, without the runner or an element. */

// The engine's own copies (this plugin does not depend on shared-types).
import {
    GstChildProcess,
    ModuleInstance,
    buildBusSink,
    busEdgeSocketPath,
    busTeeName,
} from '../../../packages/engine/src/index.js';
import {
    NATIVE_RUNNER,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { build302mEncodeBranch } from '../../audio-302m-core/engine/index.js';
import { N1Mixer302mModule } from '../engine/N1Mixer302mModule.js';

const ELEMENTS = [
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
    'level',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
/** Never the user's registry: the gate's own, or one of this run's. */
const registry =
    process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b197n1-registry-${process.pid}.bin`);

function skipReason(): string | null {
    if (!existsSync(NATIVE_RUNNER)) return 'mr-gst-runner not built (make native)';
    if (!existsSync(TIMING_PLUGIN)) return 'the timing plugin is not built (libgstmrtshouse.so)';
    const env = { ...process.env, GST_REGISTRY: registry };
    const absent = ELEMENTS.filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
}
const skip = skipReason();

const TONE = 41801;
const DARK = 41802;
const C0 = 'tone:out-0-n1:in-0';
const C1 = 'dark:out-0-n1:in-1';

describe.skipIf(skip !== null)(
    'N-1 Audio Mixer (302M) launched with an input whose producer is down (B-197)',
    { timeout: 120_000 },
    () => {
        const saved = { bus: process.env.MR_BUS_SOCKET_DIR, registry: process.env.GST_REGISTRY };
        // Short: an edge's bind path (+ '.<pid>') must fit sun_path whatever TMPDIR is.
        const dir = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'b197n1-'));
        const runners: GstChildProcess[] = [];

        beforeAll(() => {
            process.env.MR_BUS_SOCKET_DIR = dir;
            process.env.GST_REGISTRY = registry;
        });
        afterAll(async () => {
            for (const r of runners) await r.destroy();
            for (const [k, v] of [
                ['MR_BUS_SOCKET_DIR', saved.bus],
                ['GST_REGISTRY', saved.registry],
            ] as const) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b197n1-registry-'))
                rmSync(registry, { force: true });
        }, 60_000);

        async function producer(port: number, conn: string): Promise<GstChildProcess> {
            const p = new GstChildProcess();
            runners.push(p);
            const playing = new Promise<void>((r) =>
                p.on('stateChange', (d: { state: string }) => d.state === 'playing' && r()),
            );
            await p.start({
                pipeline: `audiotestsrc is-live=true wave=sine volume=0.2 ! audio/x-raw,rate=48000,channels=2 ! ${build302mEncodeBranch()} ! ${buildBusSink(port)}`,
            });
            await playing;
            p.sendBusAttach(busTeeName(port), busEdgeSocketPath(port, conn));
            expect(await until(() => existsSync(busEdgeSocketPath(port, conn)), 10_000)).toBe(true);
            return p;
        }

        /** Meter readings off one of the N-1's outputs (one a second at the least). */
        async function meter(
            n1: N1Mixer302mModule,
            port: number,
        ): Promise<{ readings: () => number; peak: () => number }> {
            const edge = busEdgeSocketPath(port, `n1:out-meter-${port}`);
            n1.getChildProcess()!.sendBusAttach(busTeeName(port), edge);
            expect(await until(() => existsSync(edge), 10_000)).toBe(true);
            const m = new GstChildProcess();
            runners.push(m);
            let readings = 0;
            let peak = 0;
            m.on('vuData', (d: { peak: number[] }) => {
                readings++;
                peak = Math.max(...d.peak);
            });
            await m.start({
                pipeline: `unixfdsrc socket-path=${edge} ! mrtsdemux select=audio/x-smpte-302m ! avdec_s302m ! audioconvert ! level post-messages=true interval=100000000 ! fakesink sync=false`,
            });
            return { readings: () => readings, peak: () => peak };
        }

        it('plays the inputs that run; the input whose producer comes up joins without a relaunch', async () => {
            await producer(TONE, C0);
            N1Mixer302mModule.setS302mSupported(true);
            const n1 = new N1Mixer302mModule();
            const ports = new Map<string, number>();
            const instance = new ModuleInstance(
                'n1',
                'n1-mixer-302m',
                n1 as unknown as ConstructorParameters<typeof ModuleInstance>[2],
                { pairCount: 2, channels: 2 },
                {
                    instanceId: 'n1',
                    pipeWire: {} as never,
                    mediaRouter: {
                        assignBusChannel: (_id: string, p: string) => {
                            if (!ports.has(p)) ports.set(p, 41810 + ports.size);
                            return { port: ports.get(p)! };
                        },
                        releaseAllBusChannelsFor: () => {},
                        onProducerPlaying: () => {},
                        getModuleBusSources: () => [
                            {
                                port: TONE,
                                socketPath: busEdgeSocketPath(TONE, C0),
                                connectionId: C0,
                                sinkPortId: 'in-0',
                                sourceChannels: 2,
                                sourceModuleId: 'tone',
                            },
                            {
                                port: DARK,
                                socketPath: busEdgeSocketPath(DARK, C1),
                                connectionId: C1,
                                sinkPortId: 'in-1',
                                sourceChannels: 2,
                                sourceModuleId: 'dark',
                            },
                        ],
                        hasStoredEdge: () => false,
                        getModuleConnections: () => [],
                        moduleName: (id: string) => id,
                    },
                    processManager: { releaseAll: async () => {} },
                    deviceProviders: {},
                } as never,
            );
            try {
                await instance.start();
                // Before: 'Waiting for producer bus socket(s)' for in-1's, and nothing ran.
                expect(await until(() => n1.getChildProcess()?.isRunning === true, 15_000)).toBe(
                    true,
                );
                expect(n1.isLiveInputLost(n1.getLiveInputBranch('in-1', C1)!.name)).toBe(true);
                // Out 1 mixes in-0: it carries the tone.
                const out1 = await meter(n1, ports.get('out-1')!);
                expect(await until(() => out1.readings() >= 3, 10_000)).toBe(true);
                expect(out1.peak()).toBeGreaterThan(8);
                // in-1's producer comes up: the engine adds its branch live (rejoin), no relaunch.
                const launch = n1.getChildProcess()!.pipelineLaunchedAt;
                await producer(DARK, C1);
                await n1.getChildProcess()!.busInputAdd(n1.getLiveInputBranch('in-1', C1)!);
                const out0 = await meter(n1, ports.get('out-0')!);
                expect(await until(() => out0.readings() >= 3 && out0.peak() > 8, 10_000)).toBe(
                    true,
                );
                expect(n1.getChildProcess()!.pipelineLaunchedAt).toBe(launch);
            } finally {
                await instance.stop();
            }
        });
    },
);

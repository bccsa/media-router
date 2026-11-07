import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-214 on a real PipeWire: the output on a 4-port AUX sink, its stream linked in index order as
 *  WirePlumber links an unpositioned one (ADR-0014; no WirePlumber here, its own matching is
 *  DEV-P3b's), the sink's monitor read. MR-052's mono on channel 1, MR-054's first start. */

import {
    GstChildProcess,
    ModuleInstance,
    PipeWireManager,
    buildBusSink,
    busEdgeSocketPath,
    busTeeName,
} from '@media-router/engine';
import { build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
// The engine's own copy: this plugin does not depend on shared-types.
import { setLogTap } from '../../../packages/shared-types/src/index.js';
import {
    PrivatePipeWire,
    auxPositions,
    linkPlaybackStreams,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';
import { edge, engineOf } from './mixRig.js';

const SINK = 'c35_aux';
const WIDTH = 4;
const ELEMENTS = [
    'pulsesink',
    'pulsesrc',
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
    'capssetter',
    'level',
    'valve',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-c35-registry-${process.pid}.bin`);
const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip) console.warn(`[B-214] AUX sink test skipped — ${skip}`);
});

/** The sink's monitor, all four channels (S16LE), its ports linked in index order by hand. */
class AuxMonitor {
    private running = true;
    private constructor(
        private readonly rec: GstChildProcess,
        private readonly file: string,
        private readonly loop: Promise<void>,
        private readonly stopLoop: () => void,
    ) {}

    static async start(pw: PrivatePipeWire, file: string): Promise<AuxMonitor> {
        let running = true;
        const loop = (async () => {
            while (running) {
                const inputs = (await pw.tool('pw-link', ['-i'])).split('\n').filter(Boolean);
                const links = await pw.tool('pw-link', ['-l']);
                const byNode = new Map<string, string[]>();
                for (const port of inputs) {
                    const node = port.slice(0, port.lastIndexOf(':'));
                    if (!pw.devices.includes(node))
                        byNode.set(node, [...(byNode.get(node) ?? []), port]);
                }
                for (const ports of byNode.values()) {
                    for (const [i, port] of ports.slice(0, WIDTH).entries()) {
                        const from = `${SINK}:monitor_AUX${i}`;
                        if (!links.includes(`${from}\n  |-> ${port}`)) {
                            await pw.tool('pw-link', [from, port]);
                        }
                    }
                }
                await sleep(250);
            }
        })();
        const rec = new GstChildProcess();
        await rec.start({
            pipeline:
                `pulsesrc device=${SINK}.monitor buffer-time=20000 latency-time=10000` +
                // Quad: its pulse map (FL FR RL RR) is in GStreamer's channel order, so port i is channel i.
                ` ! audio/x-raw,format=S16LE,rate=48000,channels=${WIDTH},channel-mask=(bitmask)0x33` +
                ` ! filesink location=${file} buffer-mode=unbuffered`,
        });
        const m = new AuxMonitor(rec, file, loop, () => {
            running = false;
        });
        if (!(await until(() => m.at() > 0.5, 10_000))) throw new Error('monitor not recording');
        return m;
    }

    /** Seconds recorded so far. */
    at(): number {
        return existsSync(this.file) ? statSync(this.file).size / (96_000 * WIDTH) : 0;
    }

    /** The share of 10 ms windows of the last `ms` in which channel `ch` is above -40 dBFS. */
    presence(ch: number, ms = 1000): number {
        const buf = readFileSync(this.file);
        const frame = 2 * WIDTH;
        const last = Math.floor(buf.length / (480 * frame));
        const first = Math.max(0, last - Math.round(ms / 10));
        let on = 0;
        for (let w = first; w < last; w++) {
            let sum = 0;
            for (let i = w * 480; i < (w + 1) * 480; i++) {
                const x = buf.readInt16LE(i * frame + ch * 2) / 32768;
                sum += x * x;
            }
            if (Math.sqrt(sum / 480) > 0.01) on++;
        }
        return last > first ? on / (last - first) : 0;
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.stopLoop();
        await this.loop;
        await this.rec.destroy();
    }
}

describe.skipIf(skip !== null)(
    'Audio Output (302M) on a 4-port AUX sink (B-214)',
    { timeout: 180_000 },
    () => {
        let pw: PrivatePipeWire;
        let mon: AuxMonitor;
        let stopLinking: () => Promise<void>;
        let savedBusDir: string | undefined;
        let cleanup: Array<() => Promise<void>> = [];
        const lines: Array<{ name: string; msg: string }> = [];

        /** Which channels sound over the last second: the one(s) expected, and only those. */
        const sounding = () =>
            Array.from({ length: WIDTH }, (_, ch) => mon.presence(ch)).map((p) => p > 0.9);

        beforeAll(async () => {
            pw = new PrivatePipeWire({ auxSinks: { [SINK]: WIDTH } });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap((l: string) => lines.push(JSON.parse(l)));
            await pw.start();
            stopLinking = linkPlaybackStreams(pw, SINK, 250, auxPositions(WIDTH));
            mon = await AuxMonitor.start(pw, join(pw.root, 'monitor.raw'));
        }, 120_000);

        afterEach(async () => {
            for (const c of cleanup.reverse()) await c();
            cleanup = [];
            lines.length = 0;
            await sleep(500);
        }, 60_000);

        afterAll(async () => {
            await mon?.stop();
            await stopLinking?.();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-c35-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        it('MR-052: a mono output on channel 1 plays on channel 1 only, as channel 1 of a 2-wide unpositioned stream', async () => {
            const port = 41961;
            const producer = new GstChildProcess();
            cleanup.push(() => producer.destroy());
            const producerPlaying = new Promise<void>((resolve) =>
                producer.on('stateChange', (d: { state: string }) => {
                    if (d.state === 'playing') resolve();
                }),
            );
            await producer.start({
                pipeline:
                    'audiotestsrc is-live=true wave=sine volume=0.2' +
                    ' ! audio/x-raw,rate=48000,channels=2' +
                    ` ! ${build302mEncodeBranch()} ! ${buildBusSink(port)}`,
            });
            await producerPlaying;
            const socket = busEdgeSocketPath(port, 'c35-mono');
            producer.sendBusAttach(busTeeName(port), socket);
            expect(await until(() => existsSync(socket), 10_000)).toBe(true);

            const module = new AudioOutput302mModule();
            const instance = new ModuleInstance(
                'c35-out',
                'audio-output-302m',
                module,
                { device: SINK, channels: 1, firstChannel: 1 },
                {
                    instanceId: 'c35-out',
                    pipeWire: new PipeWireManager(),
                    mediaRouter: {
                        assignBusChannel: () => ({ port: 41962 }),
                        releaseAllBusChannelsFor: () => {},
                        onProducerPlaying: () => {},
                        getModuleBusSources: () => [
                            {
                                port,
                                socketPath: socket,
                                connectionId: 'c35-mono',
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
            cleanup.push(() => instance.stop());
            await instance.start();
            expect(await until(() => module.getState().health === 'ok', 30_000)).toBe(true);
            expect(await until(() => sounding()[0], 20_000)).toBe(true);
            await sleep(1500);
            expect(sounding()).toEqual([true, false, false, false]);
            // The stream as pipewire-pulse has it: two channels with no positions (aux0, aux1),
            // which a session manager links port for port; a mono one reaches two ports (MR-052).
            const inputs = await pw.tool('pactl', ['list', 'sink-inputs']);
            const ours = inputs
                .split(/\n(?=Sink Input #)/)
                .find((b) => /Sample Specification: \S+ 2ch 48000Hz/.test(b));
            expect(ours, inputs).toBeDefined();
            expect(ours).toMatch(/Channel Map: aux0,aux1/);
        });

        it("MR-054: a 4-source 4-channel output's first start, NYA 125 ms ahead of the others: PLAYING, on time, each source on its own channel", async () => {
            const mod = (pluginId: string, displayName: string, settings: object) => ({
                pluginId,
                displayName,
                enabled: true,
                settings,
            });
            const feeds = ['eng', 'fra', 'nya', 'swa'];
            const modules: Record<string, object> = {
                out: mod('audio-output-302m', 'OUT1-4', {
                    device: SINK,
                    channels: 4,
                    firstChannel: 1,
                }),
            };
            const connections: object[] = [];
            feeds.forEach((f, i) => {
                // The Master feeds; NYA's transcoder 125 ms ahead.
                modules[f] = mod('tone', `${f} master`, { freq: 440 + 110 * i });
                modules[`${f}xc`] = mod('relay', `${f} transcoder`, {
                    delayMs: f === 'nya' ? 0 : 125,
                });
                connections.push(edge(f, `${f}xc`));
                connections.push({
                    ...edge(`${f}xc`, 'out'),
                    channelMap: [{ srcChannel: 0, dstChannel: i }],
                });
            });
            const e = engineOf({ modules, connections });
            cleanup.push(() => e.lifecycle.stopAll());
            const t0 = Date.now();
            await e.lifecycle.startAll();
            const out = () => e.modules.get('out')!.getPlugin() as unknown as AudioOutput302mModule;
            expect(await until(() => sounding().every(Boolean), 30_000)).toBe(true);
            console.log(
                `[MR-054] 4 sources, 4 channels: all four sound ${Date.now() - t0} ms after the start`,
            );
            await sleep(5000);
            expect(sounding()).toEqual([true, true, true, true]);
            expect(out().getState().health).toBe('ok');
            const late = lines.filter((l) => /^Plays nothing/.test(l.msg)).map((l) => l.msg);
            expect(late).toEqual([]);
        });
    },
);

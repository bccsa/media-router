import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** v104 blocker 1 (.156, 24 Nov), the Audio Decoder on a real PipeWire: a private daemon, the real
 *  module on the native runner, a 302M tone from a runner off PipeWire. A PipeWire restart takes
 *  the decoder's null sink with it; its pinned stream (#736) then waited for good ("did not reach
 *  PLAYING within 10000 ms"). It comes back as the 302M does: the null sink made again, playing
 *  into it, its pw-links out re-made. Skipped, saying why, without PipeWire, an element, the
 *  plugin or the runner. */

import {
    GstChildProcess,
    ModuleInstance,
    PipeWireManager,
    buildBusSink,
    busEdgeSocketPath,
    busTeeName,
} from '@media-router/engine';
import { setLogTap } from '@media-router/shared-types';
import {
    PrivatePipeWire,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { AudioDecoderModule } from '../engine/AudioDecoderModule.js';

const ID = 'b1-dec';
const NULL_SINK = `MR_PW_${ID}`;
/** The private PipeWire needs one device; nothing plays into it. */
const DEVICE = 'b1_spk';
const PORT = 41961;
const CONN = 'b1-tone';
const ELEMENTS = [
    'pulsesink',
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
    'decodebin',
    'level',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');

/** Never the user's registry: the gate's own, or one of this run's. */
const registry =
    process.env.GST_REGISTRY ?? join(tmpdir(), `mr-v104b1-registry-${process.pid}.bin`);

const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip)
        console.warn(`[v104 B1] real PipeWire restart test (Audio Decoder) skipped — ${skip}`);
});

/** `pw-cli` on the private PipeWire; '' when it fails. */
const pwCli = (pw: PrivatePipeWire, args: string[]) =>
    new Promise<string>((resolve) =>
        execFile('pw-cli', args, { env: pw.childEnv(), timeout: 3000 }, (err, out) =>
            resolve(err ? '' : String(out)),
        ),
    );

/** WirePlumber's part, which this PipeWire runs without: the null sink's ports (pipewire-pulse
 *  makes the node, a session manager its ports), then the decoder's stream into it. Never the null
 *  sink's own monitor into its own playback. */
function linkIntoNullSink(pw: PrivatePipeWire): () => Promise<void> {
    let running = true;
    const loop = (async () => {
        while (running) {
            const outputs = (await pw.tool('pw-link', ['-o']).catch(() => '')).split('\n');
            if (!outputs.some((p) => p.startsWith(`${NULL_SINK}:`))) {
                const id = (await pwCli(pw, ['ls', 'Node']))
                    .split(/\n\s*id /)
                    .find((b) => b.includes(`node.name = "${NULL_SINK}"`))
                    ?.match(/^(\d+),/)?.[1];
                if (id) {
                    await pwCli(pw, [
                        'set-param',
                        id,
                        'PortConfig',
                        '{ "direction": "Input", "mode": "dsp", "monitor": true, "format": { "mediaType": "audio", "mediaSubtype": "raw", "format": "F32P", "rate": 48000, "channels": 2, "position": [ "FL", "FR" ] } }',
                    ]);
                }
            }
            const links = await pw.tool('pw-link', ['-l']).catch(() => '');
            const node = (p: string) => p.slice(0, p.lastIndexOf(':'));
            const ports = outputs
                .filter((p) => p && !pw.devices.includes(node(p)) && !node(p).startsWith('MR_PW_'))
                .sort();
            for (const [i, port] of ports.slice(0, 2).entries()) {
                const to = `${NULL_SINK}:playback_${i ? 'FR' : 'FL'}`;
                if (!links.includes(`${port}\n  |-> ${to}`)) {
                    await pw.tool('pw-link', [port, to]).catch(() => '');
                }
            }
            await sleep(250);
        }
    })();
    return async () => {
        running = false;
        await loop;
    };
}

describe.skipIf(skip !== null)(
    'Audio Decoder on a real PipeWire that restarts (v104 B1)',
    { timeout: 120_000 },
    () => {
        let pw: PrivatePipeWire;
        let producer: GstChildProcess;
        let instance: ModuleInstance;
        let module: AudioDecoderModule;
        let stopLinking: () => Promise<void>;
        let savedBusDir: string | undefined;
        const relink = vi.fn(async () => {});
        const lines: Array<{ name: string; msg: string }> = [];
        const state = () => module.getState();
        /** The null sink RUNNING with a stream on it: the decoder plays into it. */
        const playing = async () => {
            const sinks = await pw.tool('pactl', ['list', 'short', 'sinks']).catch(() => '');
            const sink = sinks.split('\n').find((l) => l.split('\t')[1] === NULL_SINK);
            if (!sink || !/\tRUNNING$/.test(sink)) return false;
            const inputs = await pw.tool('pactl', ['list', 'short', 'sink-inputs']).catch(() => '');
            return inputs.split('\n').some((l) => l.split('\t')[1] === sink.split('\t')[0]);
        };
        const playsAgain = async (budgetMs: number) => {
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
                if (state().health === 'ok' && (await playing())) return true;
                await sleep(100);
            }
            return false;
        };

        beforeAll(async () => {
            pw = new PrivatePipeWire({ sinks: [DEVICE] });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap((l) => lines.push(JSON.parse(l)));
            await pw.start();
            stopLinking = linkIntoNullSink(pw);

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
                    ' ! audio/x-raw,rate=48000,channels=2 ! audioconvert ! audioresample' +
                    ' ! audio/x-raw,format=S32LE,rate=48000,channels=2' +
                    ' ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7' +
                    ` ! ${buildBusSink(PORT)}`,
            });
            await producerPlaying;
            const edge = busEdgeSocketPath(PORT, CONN);
            producer.sendBusAttach(busTeeName(PORT), edge);
            expect(await until(() => existsSync(edge), 10_000)).toBe(true);

            module = new AudioDecoderModule();
            instance = new ModuleInstance(ID, 'audio-decoder', module, { channels: 2 }, {
                instanceId: ID,
                pipeWire: new PipeWireManager(),
                mediaRouter: {
                    assignBusChannel: () => ({ port: 41962 }),
                    releaseAllBusChannelsFor: () => {},
                    onProducerPlaying: () => {},
                    getModuleBusSource: () => ({
                        port: PORT,
                        socketPath: edge,
                        connectionId: CONN,
                        sourceModuleId: 'tone',
                        sourcePortId: 'mpegts-out',
                    }),
                    getModuleBusSources: () => [],
                    hasStoredEdge: () => false,
                    reexecuteOutgoingPwLinks: relink,
                },
                processManager: { releaseAll: async () => {} },
                deviceProviders: {},
            } as any);
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
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-v104b1-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        it('restarted (~0.2 s down): a warning, never an error, its null sink made again and playing into it within 10 s, its pw-links out re-made', async () => {
            const health: string[] = [];
            const onHealth = () => health.push(state().health);
            module.on('stateChange', onHealth);
            await pw.stop();
            await sleep(200);
            await pw.start();
            const back = Date.now();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            expect(state().error).toMatch(/^PipeWire (restarted|stream failed)/);
            expect(await playsAgain(10_000)).toBe(true);
            const ms = Date.now() - back;
            console.log(`[v104 B1] Audio Decoder: playing again ${ms} ms after PipeWire returned`);
            module.off('stateChange', onHealth);
            expect(health).not.toContain('error');
            expect(lines.map((l) => l.msg)).toContain('PipeWire stream rebuilt');
            expect(relink).toHaveBeenCalledWith(ID);
        });

        it('down over 5 s: waits with the warning, then plays again within 10 s of the return', async () => {
            relink.mockClear();
            await pw.stop();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            await sleep(5000);
            expect(state().health).toBe('warning');
            await pw.start();
            const back = Date.now();
            expect(await playsAgain(10_000)).toBe(true);
            console.log(
                `[v104 B1] Audio Decoder, outage: playing again ${Date.now() - back} ms after PipeWire returned`,
            );
            expect(relink).toHaveBeenCalledOnce();
        });
    },
);

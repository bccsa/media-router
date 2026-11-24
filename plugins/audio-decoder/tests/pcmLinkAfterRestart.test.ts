import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** v104 F1/F2 (Fable review of 26ef69fd) on a real PipeWire: the engine's router, lifecycle and
 *  PCM executor, a 302M tone into the Audio Decoder, its Audio Out into an Audio Encoder (a real
 *  consumer node: its own null sink). PipeWire restarts and the encoder comes back more than 3 s
 *  after the decoder, so the decoder's re-link finds no ports and fails. The encoder's own re-link
 *  must make the pw-link then; before F1 the failed re-link dropped the edge and nothing made it
 *  (silent, every module ok). Skipped, saying why, without PipeWire, an element or the runner. */

import { GstPluginBase, buildBusSink, type PipelineDescription } from '@media-router/engine';
import { setLogTap } from '@media-router/shared-types';
import { PipeWireManager } from '../../../packages/engine/src/audio/PipeWireManager.js';
import {
    PrivatePipeWire,
    linkOwnNodes,
    realPipeWireSkip,
    sleep,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { ModuleLifecycle } from '../../../packages/engine/src/modules/ModuleLifecycle.js';
import { ModuleManager } from '../../../packages/engine/src/modules/ModuleManager.js';
import type { PluginModule } from '../../../packages/engine/src/plugins/PluginModule.js';
import { MediaRouter } from '../../../packages/engine/src/routing/MediaRouter.js';
import { AudioEncoderModule } from '../../audio-encoder/engine/AudioEncoderModule.js';
import { AudioDecoderModule } from '../engine/AudioDecoderModule.js';

const ELEMENTS = [
    'pulsesink',
    'pipewiresrc',
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'decodebin',
    'opusenc',
    'mpegtsmux',
    'level',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
const registry =
    process.env.GST_REGISTRY ?? join(tmpdir(), `mr-v104f1-registry-${process.pid}.bin`);
const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip) console.warn(`[v104 F1] real PipeWire PCM re-link test skipped — ${skip}`);
});

/** A 302M tone on the bus, as an MPEG-TS producer. */
class ToneSource extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        const id = this.services!.instanceId;
        const ep = this.services!.mediaRouter!.assignBusChannel(id, 'mpegts-out')!;
        return {
            pipeline:
                'audiotestsrc is-live=true wave=sine volume=0.2 ! audio/x-raw,rate=48000,channels=2' +
                ' ! audioconvert ! audioresample ! audio/x-raw,format=S32LE,rate=48000,channels=2' +
                ` ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7 ! ${buildBusSink(ep.port)}`,
            restartOnError: true,
            eosDrain: false,
        };
    }
}

const port = (id: string, direction: 'input' | 'output', streamType: string) => ({
    id,
    direction,
    streamType,
    maxConnections: -1,
});
const LOADER: Record<string, { ModuleClass: new () => PluginModule; manifest: object }> = {
    tone: {
        ModuleClass: ToneSource as unknown as new () => PluginModule,
        manifest: { ports: [port('mpegts-out', 'output', 'muxed/mpegts')] },
    },
    'audio-decoder': {
        ModuleClass: AudioDecoderModule as unknown as new () => PluginModule,
        manifest: {
            ports: [
                port('mpegts-in', 'input', 'muxed/mpegts'),
                port('audio-out', 'output', 'audio/pcm'),
            ],
        },
    },
    'audio-encoder': {
        ModuleClass: AudioEncoderModule as unknown as new () => PluginModule,
        manifest: {
            ports: [
                port('audio-in', 'input', 'audio/pcm'),
                port('mpegts-out', 'output', 'muxed/mpegts'),
            ],
        },
    },
};

const edge = (src: string, srcPort: string, sink: string, sinkPort: string) => ({
    id: `${src}:${srcPort}-${sink}:${sinkPort}`,
    sourceModuleId: src,
    sourcePortId: srcPort,
    sinkModuleId: sink,
    sinkPortId: sinkPort,
});

describe.skipIf(skip !== null)(
    'Audio Decoder -> Audio Encoder pw-link after a PipeWire restart, the encoder back late (v104 F1)',
    { timeout: 180_000 },
    () => {
        let pw: PrivatePipeWire;
        let stopLinking: () => Promise<void>;
        let lifecycle: ModuleLifecycle;
        let modules: ModuleManager;
        let savedBusDir: string | undefined;
        /** The decoder's monitor linked into the encoder's null sink, both channels. */
        const linked = async () => {
            const l = await pw.tool('pw-link', ['-l']);
            return ['FL', 'FR'].every((c) =>
                l.includes(`MR_PW_dec:monitor_${c}\n  |-> MR_PW_enc:playback_${c}`),
            );
        };

        beforeAll(async () => {
            pw = new PrivatePipeWire({ sinks: ['f1_spk'] });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap(() => {});
            await pw.start();
            stopLinking = linkOwnNodes(pw);
            const config: Record<string, unknown> = {
                modules: {
                    tone: { pluginId: 'tone', displayName: 'Tone', enabled: true, settings: {} },
                    dec: {
                        pluginId: 'audio-decoder',
                        displayName: 'Decoder',
                        enabled: true,
                        settings: {},
                    },
                    enc: {
                        pluginId: 'audio-encoder',
                        displayName: 'Encoder',
                        enabled: true,
                        settings: { codec: 'opus', channels: 2, sampleRate: 48000, bitrate: 128 },
                    },
                },
                connections: [
                    edge('tone', 'mpegts-out', 'dec', 'mpegts-in'),
                    edge('dec', 'audio-out', 'enc', 'audio-in'),
                ],
            };
            const loader = { get: (id: string) => LOADER[id], settle: async () => {} } as any;
            const pipeWire = new PipeWireManager();
            const router = new MediaRouter();
            modules = new ModuleManager(
                loader,
                pipeWire,
                router,
                { releaseAll: async () => {} } as any,
                {} as any,
            );
            router.setDependencies(
                pipeWire,
                (id) => modules.get(id),
                (id) => (config.modules as any)[id]?.displayName ?? id,
            );
            router.setStoredConnectionsProvider(() => config.connections as any);
            lifecycle = new ModuleLifecycle(modules, router, pipeWire, () => config, loader);
            await lifecycle.startAll();
            const deadline = Date.now() + 60_000;
            while (!(await linked()) && Date.now() < deadline) await sleep(250);
            expect(await linked()).toBe(true);
        }, 150_000);

        afterAll(async () => {
            await lifecycle?.stopAll().catch(() => {});
            await stopLinking?.();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-v104f1-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        it('the decoder re-links first and fails; the encoder, back 4.5 s later, makes the link', async () => {
            const enc = modules.get('enc')!.getPlugin() as any;
            const rebuild = enc.onDeviceReconnected.bind(enc);
            enc.onDeviceReconnected = async () => {
                await sleep(4500);
                return rebuild();
            };
            await pw.stop();
            await sleep(200);
            await pw.start();
            const deadline = Date.now() + 40_000;
            while (!(await linked()) && Date.now() < deadline) await sleep(250);
            const ok = await linked();
            console.log(`[v104 F1] decoder -> encoder pw-link back: ${ok}`);
            expect(ok).toBe(true);
            expect(modules.get('dec')!.getPlugin().getState().health).toBe('ok');
            expect(enc.getState().health).toBe('ok');
        });
    },
);

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-197 (MR-003, .108 1 Nov) on a real PipeWire: the engine's router, lifecycle and applier, the
 *  real Audio Mixer and Audio Output (302M) on the native runner, tones as 302M sources, what
 *  reaches the virtual sink recorded off its monitor. Two mic tones mix on the left channel (the
 *  Audio Mixer), the SRT leg's tone (a relay in the Audio Transcoder's shape) on the right.
 *  Skipped, saying why, without PipeWire, an element, the plugin or the runner. */

import {
    GstPluginBase,
    buildBusSink,
    buildBusSrc,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import { build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
// The engine's own copies: the lifecycle takes its router and manager, and this plugin does not
// depend on shared-types.
import { setLogTap } from '../../../packages/shared-types/src/index.js';
import { PipeWireManager } from '../../../packages/engine/src/audio/PipeWireManager.js';
import { ModuleLifecycle } from '../../../packages/engine/src/modules/ModuleLifecycle.js';
import { ModuleManager } from '../../../packages/engine/src/modules/ModuleManager.js';
import type { PluginModule } from '../../../packages/engine/src/plugins/PluginModule.js';
import { MediaRouter } from '../../../packages/engine/src/routing/MediaRouter.js';
import {
    MonitorRecorder,
    PrivatePipeWire,
    linkPlaybackStreams,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { AudioMixerModule } from '../../audio-mixer/engine/AudioMixerModule.js';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';

const SINK = 'c20_spk';
const L = 0;
const R = 1;
const ELEMENTS = [
    'pulsesink',
    'pulsesrc',
    'audiotestsrc',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
    'level',
    'valve',
    'audiobuffersplit',
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b197-registry-${process.pid}.bin`);
const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

/** A tone on one channel of a stereo 302M stream; `dark` (a valve) is a sender stopped. */
class TonePlugin extends GstPluginBase {
    private dark = false;
    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.dark = config.dark === true;
    }
    async onStart(): Promise<void> {
        // A capture whose device comes up late (MR-005): no channel until it does.
        const lateMs = Number(this.config.lateMs ?? 0);
        this.config.lateMs = 0;
        if (lateMs > 0) setTimeout(() => void super.onStart(), lateMs);
        else await super.onStart();
    }
    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const id = this.services!.instanceId;
        const ep = this.services!.mediaRouter!.assignBusChannel(id, 'audio-out')!;
        const [l, r] = config.right === true ? [0, 1] : [1, 0];
        return {
            pipeline:
                `audiotestsrc is-live=true wave=sine freq=${Number(config.freq)} volume=0.25` +
                ' ! audio/x-raw,rate=48000,channels=1' +
                ` ! audioconvert mix-matrix="<<(float)${l}.0>, <(float)${r}.0>>"` +
                ` ! audio/x-raw,channels=2 ! valve name=dark drop=${this.dark}` +
                ` ! ${build302mEncodeBranch()} ! ${buildBusSink(ep.port)}`,
            restartOnError: true,
            eosDrain: false,
        };
    }
    async setDark(dark: boolean): Promise<void> {
        this.dark = dark;
        await this.childProcess?.setProperty('dark', 'drop', dark);
    }
    /** Its pipeline down for `ms`, then back on its channel: an SRT read that failed (.108). */
    async outage(ms: number): Promise<void> {
        const child = this.childProcess;
        const desc = this.buildPipeline(this.config);
        if (!child || !desc) return;
        await child.stop();
        setTimeout(() => void child.start(desc), ms);
    }
}

/** The Audio Transcoder's shape: 302M in, decoded, 302M out; nothing in, nothing out. `delayMs`:
 *  a leg that late; `chunkMs`: its output in chunks (an SRT leg's rhythm); `reportMs`: what its
 *  egress window last read (.108: a transient after the SRT leg's last burst). */
class RelayPlugin extends GstPluginBase {
    reportMs: number | null = null;
    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services!.mediaRouter!;
        const id = this.services!.instanceId;
        const s = router.getModuleBusSources(id).find((x) => x.sinkPortId === 'audio-in');
        if (!s) return null;
        const ep = router.assignBusChannel(id, 'audio-out')!;
        const delayNs = Number(config.delayMs ?? 0) * 1_000_000;
        const chunkMs = Number(config.chunkMs ?? 0);
        return {
            pipeline:
                `${buildBusSrc({ port: s.port, socketPath: s.socketPath })}` +
                ' ! mrtsdemux select=audio/x-smpte-302m ! avdec_s302m ! audioconvert' +
                ' ! audio/x-raw,rate=48000,channels=2' +
                (chunkMs ? ` ! audiobuffersplit output-buffer-duration=${chunkMs}/1000` : '') +
                (delayNs
                    ? ` ! queue max-size-time=${delayNs + 2_000_000_000} max-size-buffers=0` +
                      ` max-size-bytes=0 min-threshold-time=${delayNs}`
                    : '') +
                ` ! ${build302mEncodeBranch()} ! ${buildBusSink(ep.port)}`,
            restartOnError: true,
            eosDrain: false,
        };
    }
    getTimingSummary() {
        const s = super.getTimingSummary();
        if (this.reportMs === null) return s;
        const w = { meanMs: this.reportMs, minMs: this.reportMs, maxMs: this.reportMs };
        return { ...(s ?? { inputs: [], instrument: true }), output: w };
    }
    runner() {
        return this.childProcess;
    }
}

const port = (id: string, direction: 'input' | 'output') => ({
    id,
    direction,
    streamType: 'audio/302m',
    maxConnections: -1,
});
const LOADER: Record<string, { ModuleClass: new () => PluginModule; manifest: object }> = {
    tone: {
        ModuleClass: TonePlugin as unknown as new () => PluginModule,
        manifest: { ports: [port('audio-out', 'output')] },
    },
    relay: {
        ModuleClass: RelayPlugin as unknown as new () => PluginModule,
        manifest: { ports: [port('audio-in', 'input'), port('audio-out', 'output')] },
    },
    'audio-mixer': {
        ModuleClass: AudioMixerModule as unknown as new () => PluginModule,
        manifest: { ports: [port('audio-in', 'input'), port('audio-out', 'output')] },
    },
    'audio-output-302m': {
        ModuleClass: AudioOutput302mModule as unknown as new () => PluginModule,
        manifest: { ports: [port('audio-in', 'input')] },
    },
};
const edge = (src: string, sink: string) => ({
    id: `${src}:audio-out-${sink}:audio-in`,
    sourceModuleId: src,
    sourcePortId: 'audio-out',
    sinkModuleId: sink,
    sinkPortId: 'audio-in',
});

interface Rig {
    /** The SRT leg's route declares this D (its head's `playoutOffsetMs`). */
    srtOffsetMs?: number;
    relay?: { delayMs?: number; chunkMs?: number };
    /** The mics' channels come this late at the start (their edge to the Mixer waits). */
    micsLateMs?: number;
    /** The SRT leg into the Audio Mixer, not into the output. */
    srtIntoMixer?: boolean;
}

/** The .108 rig: Mic A and B (997, 1499 Hz) into the Mixer, SRT in (440 Hz) into its transcoder,
 *  both into the Audio Output (302M); engine D 60 ms, re-anchor on, as the engine starts them. */
function engine(rig: Rig = {}) {
    const mod = (pluginId: string, displayName: string, settings: Record<string, unknown>) => ({
        pluginId,
        displayName,
        enabled: true,
        settings,
    });
    const late = rig.micsLateMs ?? 0;
    const config: Record<string, unknown> = {
        modules: {
            micA: mod('tone', 'Mic A', { freq: 997, lateMs: late }),
            micB: mod('tone', 'Mic B', { freq: 1499, lateMs: late }),
            mix: mod('audio-mixer', 'Mixer', { channels: 2 }),
            srtin: mod('tone', 'SRT in', {
                freq: 440,
                right: true,
                ...(rig.srtOffsetMs ? { playoutOffsetMs: rig.srtOffsetMs } : {}),
            }),
            srtxc: mod('relay', 'SRT transcoder', { ...rig.relay }),
            out: mod('audio-output-302m', 'Audio Output', { device: SINK, channels: 2 }),
        },
        // The profile's order: the Mixer's edge before the SRT leg's.
        connections: [
            edge('micA', 'mix'),
            edge('micB', 'mix'),
            edge('srtin', 'srtxc'),
            ...(rig.srtIntoMixer
                ? [edge('srtxc', 'mix'), edge('mix', 'out')]
                : [edge('mix', 'out'), edge('srtxc', 'out')]),
        ],
    };
    const loader = { get: (id: string) => LOADER[id], settle: async () => {} } as any;
    const pipeWire = new PipeWireManager();
    const processManager = { releaseAll: async () => {} } as any;
    const router = new MediaRouter();
    router.setPlayoutReanchor(true, 60);
    const modules = new ModuleManager(
        loader,
        pipeWire,
        router,
        processManager,
        {} as any,
        60,
        true,
    );
    router.setDependencies(
        pipeWire,
        (id) => modules.get(id),
        (id) => (config.modules as any)[id]?.displayName ?? id,
    );
    router.setStoredConnectionsProvider(() => config.connections as any);
    const lifecycle = new ModuleLifecycle(modules, router, pipeWire, () => config, loader);
    const plugin = <T>(id: string) => modules.get(id)!.getPlugin() as unknown as T;
    return {
        router,
        lifecycle,
        modules,
        srtin: () => plugin<TonePlugin>('srtin'),
        srtxc: () => plugin<RelayPlugin>('srtxc'),
        out: () => plugin<AudioOutput302mModule>('out'),
        /** The output's pipeline launch: it changes with every relaunch. */
        outLaunch: () => plugin<AudioOutput302mModule>('out').getChildProcess()?.pipelineLaunchedAt,
        head: () => router.getRoutePlayoutHead('out')?.headId,
    };
}

describe.skipIf(skip !== null)(
    'Audio Output (302M) restarted while a source is dark (B-197)',
    { timeout: 180_000 },
    () => {
        let pw: PrivatePipeWire;
        let rec: MonitorRecorder;
        let stopLinking: () => Promise<void>;
        let stopRig: (() => Promise<void>) | null = null;
        let savedBusDir: string | undefined;
        const lines: Array<{ name: string; msg: string; level: number }> = [];

        /** `ch` sounds over the last `ms` (90 % of its 10 ms windows). */
        const sounds = (ch: 0 | 1, ms = 500) =>
            rec.presence(ch, rec.at() - ms / 1000, rec.at()) > 0.9;
        const soundsWithin = (ch: 0 | 1, budgetMs: number) => until(() => sounds(ch), budgetMs);

        beforeAll(async () => {
            AudioMixerModule.setS302mSupported(true);
            pw = new PrivatePipeWire({ sinks: [SINK] });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap((l: string) => lines.push(JSON.parse(l)));
            await pw.start();
            stopLinking = linkPlaybackStreams(pw, SINK);
            rec = await MonitorRecorder.start(pw, SINK, join(pw.root, 'monitor.raw'));
        }, 120_000);

        afterEach(async () => {
            await stopRig?.();
            stopRig = null;
            lines.length = 0;
        }, 60_000);

        afterAll(async () => {
            await rec?.stop();
            await stopLinking?.();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b197-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        async function start(rig: Rig = {}) {
            const e = engine(rig);
            stopRig = () => e.lifecycle.stopAll();
            await e.lifecycle.startAll();
            return e;
        }

        it(".108's drill: restarted while the SRT leg is dark and down, re-linked with its last transient: the mics play within 3 s and on, the leg joins when it delivers, no relaunch", async () => {
            const e = await start();
            expect(await soundsWithin(L, 20_000)).toBe(true);
            expect(await soundsWithin(R, 10_000)).toBe(true);
            // The sender stops. Its transcoder's egress window last read a transient (.108: the
            // pace stood ~270 ms over the Mixer's while the leg was dark).
            await e.srtin().setDark(true);
            e.srtxc().reportMs = 400;
            await sleep(1000);
            // The SRT read fails: the input is down 4 s; its transcoder relaunches and waits for it.
            await e.srtin().outage(4000);
            await e.srtxc().runner()!.restartPipeline('its input went away');
            await e.lifecycle.restart('out');
            const restarted = rec.at();
            expect(await soundsWithin(L, 3000)).toBe(true);
            console.log(
                `[B-197] mics back ${Math.round((rec.at() - restarted) * 1000)} ms after the restart`,
            );
            // The input comes back dark, the transcoder after it, and the output takes it in live.
            const joined = await until(
                () =>
                    lines.some((l) =>
                        /^Live input (re-linked|joined) \[SRT transcoder/.test(l.msg),
                    ),
                15_000,
            );
            expect(joined).toBe(true);
            await sleep(3000);
            expect(rec.presence(L, rec.at() - 2.5, rec.at())).toBeGreaterThan(0.95);
            const launch = e.outLaunch();
            await e.srtin().setDark(false);
            expect(await soundsWithin(R, 5000)).toBe(true);
            expect(sounds(L, 1000)).toBe(true);
            expect(e.outLaunch()).toBe(launch);
        });

        it('a restart keeps the playout offset of every route the output mixes: the late leg joins and both play', async () => {
            // The SRT leg is 500 ms late and its route says D 800. The mics' channels come late, so
            // the leg's edge is the output's first; the restart re-applies the Mixer's first.
            const e = await start({ srtOffsetMs: 800, relay: { delayMs: 500 }, micsLateMs: 2500 });
            expect(await soundsWithin(L, 25_000)).toBe(true);
            expect(await soundsWithin(R, 10_000)).toBe(true);
            await e.srtin().setDark(true);
            await sleep(1000);
            await e.lifecycle.restart('out');
            expect(await soundsWithin(L, 4000)).toBe(true);
            await e.srtin().setDark(false);
            expect(await soundsWithin(R, 6000)).toBe(true);
            expect(sounds(L, 1000)).toBe(true);
            expect(e.head()).toBe('srtin');
        });

        it('a source going dark while the output plays costs the others under 100 ms (a steady 302M leg)', async () => {
            const e = await start();
            expect(await soundsWithin(L, 20_000)).toBe(true);
            expect(await soundsWithin(R, 10_000)).toBe(true);
            const gaps: number[] = [];
            for (let i = 0; i < 3; i++) {
                const at = rec.at();
                await e.srtin().setDark(true);
                await sleep(3000);
                gaps.push(rec.longestGapMs(L, at - 0.5, rec.at()));
                await e.srtin().setDark(false);
                expect(await soundsWithin(R, 6000)).toBe(true);
                await sleep(1000);
            }
            const w = e
                .out()
                .getTimingSummary()
                ?.inputs.find((x) => x.label.startsWith('srtxc'));
            console.log(
                `[B-197] dark leg (W ${Math.round(w?.silenceLimitMs ?? -1)} ms): the mics drop ${gaps.join(', ')} ms`,
            );
            expect(Math.max(...gaps)).toBeLessThan(100);
        });

        it('an Audio Mixer relaunched while a source cannot run starts with the others; that one joins when it plays', async () => {
            const e = await start({ srtIntoMixer: true });
            expect(await soundsWithin(L, 20_000)).toBe(true);
            expect(await soundsWithin(R, 10_000)).toBe(true);
            // The SRT input fails and is down 9 s: its transcoder relaunches and waits for it (.108).
            await e.srtin().outage(9000);
            await e.srtxc().runner()!.restartPipeline('its input went away');
            await sleep(500);
            // Its runner relaunches the Mixer (an error, a producer's relaunch): the same sources.
            await e.modules.get('mix')!.getChildProcess()!.restartPipeline('test');
            expect(await soundsWithin(L, 5000)).toBe(true);
            expect(await soundsWithin(R, 12_000)).toBe(true);
            expect(sounds(L, 1000)).toBe(true);
        });

        it('an output whose mix arrives past its playout time says so, not ok, and withdraws it once it plays', async () => {
            // The leg is 500 ms late on a route left at D 60: nothing plays until the route is raised.
            const e = await start({ relay: { delayMs: 500 } });
            const warned = await until(
                () =>
                    /^Plays nothing: every buffer reaches the sink \d+ ms past/.test(
                        e.out().getState().error ?? '',
                    ),
                12_000,
            );
            expect(warned).toBe(true);
            expect(e.out().getState().health).toBe('warning');
            expect(sounds(L, 2000)).toBe(false);
            // The re-anchor raises the route after its 15 s hold; then it plays and says nothing.
            expect(await soundsWithin(L, 40_000)).toBe(true);
            expect(
                await until(() => !/^Plays nothing/.test(e.out().getState().error ?? ''), 10_000),
            ).toBe(true);
        });
    },
);

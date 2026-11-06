// The .108 rig of the real-PipeWire tests (B-197, B-206): the engine's router, lifecycle and
// applier, the real Audio Mixer and Audio Output (302M) on the native runner, tones as 302M
// sources. Two mic tones mix on the left channel (the Audio Mixer), the SRT leg's tone (a relay in
// the Audio Transcoder's shape) on the right.
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
import { PipeWireManager } from '../../../packages/engine/src/audio/PipeWireManager.js';
import { ModuleLifecycle } from '../../../packages/engine/src/modules/ModuleLifecycle.js';
import { ModuleManager } from '../../../packages/engine/src/modules/ModuleManager.js';
import type { PluginModule } from '../../../packages/engine/src/plugins/PluginModule.js';
import { MediaRouter } from '../../../packages/engine/src/routing/MediaRouter.js';
import { AudioMixerModule } from '../../audio-mixer/engine/AudioMixerModule.js';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';

/** A tone on one channel of a stereo 302M stream; `dark` (a valve) is a sender stopped. */
export class TonePlugin extends GstPluginBase {
    private dark = false;
    private held: PipelineDescription | null = null;
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
        await this.down();
        setTimeout(() => void this.up(), ms);
    }
    /** Its pipeline down (a capture PipeWire took with it) until `up`. */
    async down(): Promise<void> {
        this.held = this.buildPipeline(this.config);
        await this.childProcess?.stop();
    }
    async up(): Promise<void> {
        if (this.held) await this.childProcess?.start(this.held);
    }
}

/** The Audio Transcoder's shape: 302M in, decoded, 302M out; nothing in, nothing out. `delayMs`:
 *  a leg that late; `chunkMs`: its output in chunks (an SRT leg's rhythm); `reportMs`: what its
 *  egress window last read (.108: a transient after the SRT leg's last burst). */
export class RelayPlugin extends GstPluginBase {
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

export interface Rig {
    /** The output's virtual sink. */
    sink: string;
    relay?: { delayMs?: number; chunkMs?: number };
    /** The mics' channels come this late at the start (their edge to the Mixer waits). */
    micsLateMs?: number;
    /** The SRT leg into the Audio Mixer, not into the output. */
    srtIntoMixer?: boolean;
}

/** The .108 rig: Mic A and B (997, 1499 Hz) into the Mixer, SRT in (440 Hz) into its transcoder,
 *  both into the Audio Output (302M), which plays them as they come (no playout offset, B-167). */
export function engine(rig: Rig) {
    AudioMixerModule.setS302mSupported(true);
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
            srtin: mod('tone', 'SRT in', { freq: 440, right: true }),
            srtxc: mod('relay', 'SRT transcoder', { ...rig.relay }),
            out: mod('audio-output-302m', 'Audio Output', { device: rig.sink, channels: 2 }),
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
    const e = engineOf(config);
    const plugin = <T>(id: string) => e.modules.get(id)!.getPlugin() as unknown as T;
    return {
        ...e,
        mic: (id: 'micA' | 'micB') => plugin<TonePlugin>(id),
        srtin: () => plugin<TonePlugin>('srtin'),
        srtxc: () => plugin<RelayPlugin>('srtxc'),
        out: () => plugin<AudioOutput302mModule>('out'),
        /** The output's pipeline launch: it changes with every relaunch. */
        outLaunch: () => plugin<AudioOutput302mModule>('out').getChildProcess()?.pipelineLaunchedAt,
    };
}

/** The engine's router, modules and lifecycle over `config` (`modules`, `connections`) of this
 *  rig's plugins, as the engine starts them. */
export function engineOf(config: Record<string, unknown>) {
    const loader = { get: (id: string) => LOADER[id], settle: async () => {} } as any;
    const pipeWire = new PipeWireManager();
    const processManager = { releaseAll: async () => {} } as any;
    const router = new MediaRouter();
    const modules = new ModuleManager(loader, pipeWire, router, processManager, {} as any);
    router.setDependencies(
        pipeWire,
        (id) => modules.get(id),
        (id) => (config.modules as any)[id]?.displayName ?? id,
    );
    router.setStoredConnectionsProvider(() => config.connections as any);
    const lifecycle = new ModuleLifecycle(modules, router, pipeWire, () => config, loader);
    return { router, lifecycle, modules };
}

/** A connection of this rig, `src`'s audio out into `sink`'s audio in. */
export const edge = (src: string, sink: string) => ({
    id: `${src}:audio-out-${sink}:audio-in`,
    sourceModuleId: src,
    sourcePortId: 'audio-out',
    sinkModuleId: sink,
    sinkPortId: 'audio-in',
});

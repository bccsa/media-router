import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The engine's own copy (this plugin does not depend on shared-types).
import { setLogTap, type ModuleRuntimeState } from '../../../packages/shared-types/src/index.js';
import { MediaRouter } from '../../../packages/engine/src/routing/MediaRouter.js';
import { ModuleManager } from '../../../packages/engine/src/modules/ModuleManager.js';
import { ModuleLifecycle } from '../../../packages/engine/src/modules/ModuleLifecycle.js';
import type {
    ModuleServices,
    PluginModule,
} from '../../../packages/engine/src/plugins/PluginModule.js';
import { N1Mixer302mModule } from '../engine/N1Mixer302mModule.js';

/** MR-027 (B-196): .103's 'default' rig (the N-1 Mixer, its three tones through Audio Transcoders,
 *  its three meters) in the profile's order, through the engine's lifecycle, applier and router:
 *  the real N-1 module and a fake runner; the others are fakes that keep to their plugins' rules. */
const h = vi.hoisted(() => {
    const DONE: Record<string, string> = {
        bus_input_add: 'bus_input_add_done',
        bus_input_remove: 'bus_input_remove_done',
        set_property: 'property_set',
        get_property: 'property',
        track_throughput: 'tracking',
        get_throughput: 'throughput',
        get_stats: 'stats',
    };
    /** The runner process: it plays a moment after its start, answers every tracked command,
     *  and refuses an add to an aggregator its pipeline does not have, as both runners do. */
    class FakeRunner {
        static spawned: FakeRunner[] = [];
        readonly commands: Record<string, unknown>[] = [];
        startOpts: { pipeline: string } | undefined;
        readonly stop = vi.fn(() => setTimeout(() => this.options.onExit(0, null), 0));
        readonly kill = vi.fn();
        readonly emergencyKill = vi.fn();
        constructor(
            readonly options: {
                onEvent: (event: Record<string, unknown>) => void;
                onExit: (code: number | null, signal: string | null) => void;
            },
        ) {
            FakeRunner.spawned.push(this);
        }
        get pid(): number {
            return 7000 + FakeRunner.spawned.indexOf(this);
        }
        start(opts: { pipeline: string }): void {
            this.startOpts = opts;
            setTimeout(() => this.options.onEvent({ event: 'state_change', state: 'playing' }), 5);
        }
        sendCommand(cmd: Record<string, unknown>): void {
            this.commands.push(cmd);
            const done = DONE[String(cmd.cmd)];
            if (!done || !cmd.id) return;
            const pipeline = this.startOpts?.pipeline ?? '';
            if (
                cmd.cmd === 'bus_input_add' &&
                !new RegExp(`name=${String(cmd.element)}(\\s|$)`).test(pipeline)
            ) {
                const message = `bus_input_add: element '${String(cmd.element)}' not found`;
                setTimeout(
                    () => this.options.onEvent({ event: 'command_error', id: cmd.id, message }),
                    0,
                );
                return;
            }
            setTimeout(() => this.options.onEvent({ event: done, id: cmd.id, name: cmd.name }), 0);
        }
    }
    return { FakeRunner };
});

vi.mock('../../../packages/engine/src/child-process/PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    PythonProcess: h.FakeRunner,
}));

/** How long a transcoder probes its input before it takes its channel (.103: 0.3-0.7 s). */
const PROBE_MS = 400;
/** From its channel to its launch: its runner not up yet, so a live add of it waits. */
const LAUNCH_MS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The router's check of a wait, shortened from its 10 s. */
const CHECK_MS = 2000;

abstract class FakePlugin implements PluginModule {
    protected config: Record<string, unknown> = {};
    protected services: ModuleServices | null = null;
    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        this.config = config;
        this.services = services ?? null;
    }
    abstract onStart(): Promise<void>;
    async onStop(): Promise<void> {}
    async onDestroy(): Promise<void> {}
    getState(): ModuleRuntimeState {
        return { running: true, ready: true, health: 'ok' } as ModuleRuntimeState;
    }
    getLiveUpdatableParams(): string[] {
        return [];
    }
    async onLiveConfigUpdate(): Promise<void> {}
    protected get router(): MediaRouter {
        return this.services!.mediaRouter as unknown as MediaRouter;
    }
    protected get id(): string {
        return this.services!.instanceId;
    }
}

/** A tone generator (MPEG-TS IP input): its channel at its start, always up. */
class SourcePlugin extends FakePlugin {
    private readonly child = { pipelineLaunchedAt: 0, isRunning: true };
    async onStart(): Promise<void> {
        this.router.assignBusChannel(this.id);
        this.child.pipelineLaunchedAt = Date.now();
    }
    getChildProcess() {
        return this.child;
    }
    getBusAttachTarget() {
        return { sendBusAttach: () => {}, sendBusDetach: () => {} };
    }
}

/** An Audio Transcoder (or a meter's Audio Mixer): idle with no input; with one it takes its
 *  output channel, launches a moment later and then serves its edge sockets and plays. */
class RelayPlugin extends FakePlugin {
    static outputPort = 'out-0';
    static probeMs = PROBE_MS;
    private child: {
        pipelineLaunchedAt: number | undefined;
        isRunning: boolean;
        restartPipeline: () => Promise<void>;
    } | null = null;
    private readonly edges = new Set<string>();
    private readonly servers = new Map<string, Server>();
    private launchTimer: NodeJS.Timeout | null = null;
    /** What it was last started with. */
    sources: string[] = [];

    async onStart(): Promise<void> {
        const self = this.constructor as typeof RelayPlugin;
        this.sources = this.router.getModuleBusSources(this.id).map((s) => s.sourceModuleId);
        if (this.sources.length === 0) return;
        await sleep(self.probeMs);
        this.router.assignBusChannel(this.id, self.outputPort);
        const child = {
            pipelineLaunchedAt: undefined as number | undefined,
            isRunning: false,
            restartPipeline: async () => {
                child.pipelineLaunchedAt = Date.now();
            },
        };
        this.child = child;
        this.launchTimer = setTimeout(() => void this.launch(), LAUNCH_MS);
    }
    async onStop(): Promise<void> {
        if (this.launchTimer) clearTimeout(this.launchTimer);
        this.child = null;
        for (const srv of this.servers.values()) await new Promise((r) => srv.close(r));
        this.servers.clear();
    }
    getState(): ModuleRuntimeState {
        const running = this.child?.isRunning ?? false;
        return {
            running,
            ready: running,
            health: running ? 'ok' : 'warning',
        } as ModuleRuntimeState;
    }
    getChildProcess() {
        return this.child;
    }
    getBusAttachTarget() {
        return {
            sendBusAttach: (_tee: string, socket: string) => {
                this.edges.add(socket);
                if (this.child?.isRunning) void this.serve(socket);
            },
            sendBusDetach: (socket: string) => {
                this.edges.delete(socket);
                this.servers.get(socket)?.close();
                this.servers.delete(socket);
            },
        };
    }
    private async launch(): Promise<void> {
        const child = this.child;
        if (!child) return;
        child.pipelineLaunchedAt = Date.now();
        for (const s of this.edges) await this.serve(s);
        child.isRunning = true;
        this.router.onProducerPlaying(this.id);
    }
    private async serve(socket: string): Promise<void> {
        if (this.servers.has(socket)) return;
        const srv = createServer(() => {});
        this.servers.set(socket, srv);
        await new Promise<void>((resolve) => srv.listen(socket, () => resolve()));
    }
}

/** An Audio Mixer used as a meter: its output channel is `audio-out`, no probe. */
class MeterPlugin extends RelayPlugin {
    static outputPort = 'audio-out';
    static probeMs = 0;
}

/** An Audio Input (302M) whose USB device is not connected: no channel, ever. */
class AbsentMicPlugin extends FakePlugin {
    async onStart(): Promise<void> {}
}

const out = (id: string, streamType: string, ordered = true) => ({
    id,
    direction: 'output',
    streamType,
    ...(ordered ? { requiresOrderedApply: true } : {}),
});
const inp = (id: string, streamType: string) => ({
    id,
    direction: 'input',
    streamType,
    maxConnections: -1,
});
const PLUGINS: Record<
    string,
    { ModuleClass: new () => PluginModule; manifest: { ports: object[] } }
> = {
    'mpegts-ip-input': {
        ModuleClass: SourcePlugin as unknown as new () => PluginModule,
        manifest: { ports: [out('mpegts-out', 'muxed/mpegts')] },
    },
    'audio-transcoder': {
        ModuleClass: RelayPlugin as unknown as new () => PluginModule,
        manifest: { ports: [inp('mpegts-in', 'muxed/mpegts'), out('out-0', 'audio/302m')] },
    },
    'n1-mixer-302m': {
        ModuleClass: N1Mixer302mModule as unknown as new () => PluginModule,
        manifest: { ports: [] },
    },
    'audio-mixer': {
        ModuleClass: MeterPlugin as unknown as new () => PluginModule,
        manifest: { ports: [inp('audio-in', 'audio/302m'), out('audio-out', 'audio/302m')] },
    },
    'audio-input-302m': {
        ModuleClass: AbsentMicPlugin,
        manifest: { ports: [out('audio-out', 'audio/302m', false)] },
    },
};

/** .103's module ids and names, in its profile's order. */
const MODULES: Array<[string, string, string, Record<string, unknown>?]> = [
    ['mpegts-ip-input-n1src01', 'mpegts-ip-input', 'N1 Tone 1 (440 Hz steady)'],
    ['audio-transcoder-n1in01', 'audio-transcoder', 'N1 In 1 → 302M'],
    ['mpegts-ip-input-n1src02', 'mpegts-ip-input', 'N1 Tone 2 (tick 1/s)'],
    ['audio-transcoder-n1in02', 'audio-transcoder', 'N1 In 2 → 302M'],
    ['mpegts-ip-input-n1src03', 'mpegts-ip-input', 'N1 Tone 3 (silence)'],
    ['audio-transcoder-n1in03', 'audio-transcoder', 'N1 In 3 → 302M'],
    [
        'n1-mixer-302m-n1test01',
        'n1-mixer-302m',
        'N-1 Mixer (test rig)',
        { pairCount: 3, channels: 2 },
    ],
    ['audio-mixer-n1out01', 'audio-mixer', 'N1 Out 1 meter'],
    ['audio-mixer-n1out02', 'audio-mixer', 'N1 Out 2 meter'],
    ['audio-mixer-n1out03', 'audio-mixer', 'N1 Out 3 meter'],
    ['audio-input-302m-n1wide01', 'audio-input-302m', 'N1 Wide 8ch (USB mic, 7 silent)'],
    ['audio-transcoder-muwq03vg11xn', 'audio-transcoder', 'Audio Transcoder'],
];
const N1 = 'n1-mixer-302m-n1test01';
const edge = (src: string, srcPort: string, sink: string, sinkPort: string) => ({
    id: `${src}:${srcPort}-${sink}:${sinkPort}`,
    sourceModuleId: src,
    sourcePortId: srcPort,
    sinkModuleId: sink,
    sinkPortId: sinkPort,
});
/** .103's stored connections among these modules, in its profile's order. */
const CONNECTIONS = [
    edge('mpegts-ip-input-n1src01', 'mpegts-out', 'audio-transcoder-n1in01', 'mpegts-in'),
    edge('audio-transcoder-n1in01', 'out-0', N1, 'in-0'),
    edge('mpegts-ip-input-n1src02', 'mpegts-out', 'audio-transcoder-n1in02', 'mpegts-in'),
    edge('audio-transcoder-n1in02', 'out-0', N1, 'in-1'),
    edge('mpegts-ip-input-n1src03', 'mpegts-out', 'audio-transcoder-n1in03', 'mpegts-in'),
    edge('audio-transcoder-n1in03', 'out-0', N1, 'in-2'),
    edge(N1, 'out-0', 'audio-mixer-n1out01', 'audio-in'),
    edge(N1, 'out-1', 'audio-mixer-n1out02', 'audio-in'),
    edge(N1, 'out-2', 'audio-mixer-n1out03', 'audio-in'),
    edge('audio-input-302m-n1wide01', 'audio-out', N1, 'in-0'),
    edge('audio-mixer-n1out01', 'audio-out', 'audio-transcoder-muwq03vg11xn', 'mpegts-in'),
];
const METER_1 = `${N1}:out-0-audio-mixer-n1out01:audio-in`;
const MIC = `audio-input-302m-n1wide01:audio-out-${N1}:in-0`;
/** Everything but the mic, whose device is not there. */
const UP = CONNECTIONS.map((c) => c.id)
    .filter((id) => id !== MIC)
    .sort();

const profile = (modules: typeof MODULES, connections: typeof CONNECTIONS) => ({
    modules: Object.fromEntries(
        modules.map(([id, pluginId, displayName, settings]) => [
            id,
            { pluginId, displayName, enabled: true, settings: settings ?? {} },
        ]),
    ),
    connections,
});
/** .103's 'default' profile, this rig's part of it. */
const DEFAULT = () => profile(MODULES, CONNECTIONS);
/** A TEMP profile of the 1 Nov round: other modules, which the activation of 'default' replaces. */
const TEMP = () =>
    profile(
        [
            ['mpegts-ip-input-fix2in', 'mpegts-ip-input', 'TEMP input'],
            ['audio-transcoder-fix2t3', 'audio-transcoder', 'TEMP Opus'],
        ],
        [edge('mpegts-ip-input-fix2in', 'mpegts-out', 'audio-transcoder-fix2t3', 'mpegts-in')],
    );

/** `checkMs`: how long a wait goes before the router checks on it (B-196). */
function engine(checkMs?: number) {
    let config: Record<string, unknown> = DEFAULT();
    const loader = { get: (id: string) => PLUGINS[id], settle: async () => {} } as any;
    const pipeWire = {
        releaseAll: vi.fn(async () => {}),
        cleanupOrphans: vi.fn(async () => {}),
    } as any;
    const processManager = { releaseAll: vi.fn(async () => {}) } as any;
    const router = new MediaRouter(checkMs);
    const modules = new ModuleManager(loader, pipeWire, router, processManager, {} as any);
    const names = (id: string) => (config.modules as any)[id]?.displayName ?? id;
    router.setDependencies(pipeWire, (id) => modules.get(id), names);
    const lifecycle = new ModuleLifecycle(modules, router, pipeWire, () => config, loader);
    return {
        router,
        lifecycle,
        /** A profile activation: the new profile's modules and connections, all started again. */
        activate: async (next: Record<string, unknown>) => {
            config = next;
            await lifecycle.startAll();
        },
        plugin: <T>(id: string) => modules.get(id)!.getPlugin() as unknown as T,
        live: () =>
            router
                .getConnections()
                .map((c) => c.id)
                .sort(),
    };
}

describe('.103: the N-1 Mixer and its meters come up at a start and a profile activation (B-196, MR-027)', () => {
    let dir: string;
    let lines: Array<{ level: number; name: string; msg: string }>;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'mr-b196-'));
        vi.stubEnv('MR_BUS_SOCKET_DIR', dir);
        h.FakeRunner.spawned = [];
        N1Mixer302mModule.setS302mSupported(true);
        lines = [];
        setLogTap((l) => lines.push(JSON.parse(l)));
    });

    afterEach(() => {
        setLogTap(null);
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    /** The N-1 Mixer's input fan-ins in the pipeline its runner runs now. */
    const n1Inputs = () => {
        const last = [...h.FakeRunner.spawned]
            .reverse()
            .find((py) => /name=inmix\d/.test(py.startOpts?.pipeline ?? ''));
        return [...(last?.startOpts?.pipeline ?? '').matchAll(/name=(inmix\d+)(?=\s|$)/g)]
            .map((m) => m[1])
            .sort();
    };

    async function expectAllUp(e: ReturnType<typeof engine>): Promise<void> {
        // N1 Out 1 meter and every other sink within about 5 s (.103 old code: about 4 s).
        await vi.waitFor(() => expect(e.live()).toEqual(UP), { timeout: 5000, interval: 50 });
        // The mixer mixes all three tones: N1 Out 2 and 3 meters carry two each, not one.
        await vi.waitFor(() => expect(n1Inputs()).toEqual(['inmix0', 'inmix1', 'inmix2']));
        expect(e.plugin<RelayPlugin>('audio-mixer-n1out01').sources).toEqual([N1]);
        expect(e.plugin<RelayPlugin>('audio-transcoder-muwq03vg11xn').sources).toEqual([
            'audio-mixer-n1out01',
        ]);
        // Only the mic waits: its USB device is not connected.
        expect(e.router.isConnectionWaiting(METER_1)).toBe(false);
        expect(e.router.isConnectionWaiting(MIC)).toBe(true);
        expect(lines.filter((l) => l.level >= 50)).toEqual([]);
    }

    /** Past every wait's check: nothing to name, the mic's wait (no device) included. */
    async function expectNoWarning(e: ReturnType<typeof engine>): Promise<void> {
        await sleep(CHECK_MS + 300);
        expect(lines.filter((l) => l.name === 'MediaRouter' && l.level === 40)).toEqual([]);
        expect(e.router.isConnectionWaiting(MIC)).toBe(true);
    }

    it("an engine start (the deploy's): every connection but the absent mic's is up", async () => {
        const e = engine(CHECK_MS);
        await e.lifecycle.startAll();
        await expectAllUp(e);
        // The meter's connection still waits a moment, until the mixer has a second input.
        expect(
            lines.some(
                (l) =>
                    l.name === 'MediaRouter' &&
                    l.msg ===
                        'Connection [N-1 Mixer (test rig) → N1 Out 1 meter] waits for N-1 Mixer (test rig): its output is not up yet',
            ),
        ).toBe(true);
        await expectNoWarning(e);
        await e.lifecycle.stopAll();
    }, 30_000);

    it("a profile activation (a TEMP profile, then 'default'): every connection but the absent mic's is up", async () => {
        const e = engine(CHECK_MS);
        await e.activate(TEMP());
        lines = [];
        await e.activate(DEFAULT());
        await expectAllUp(e);
        await expectNoWarning(e);
        await e.lifecycle.stopAll();
    }, 30_000);
});

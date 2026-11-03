import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLogTap, type ModuleRuntimeState } from '@media-router/shared-types';
import { ModuleManager } from './ModuleManager.js';
import { ModuleLifecycle } from './ModuleLifecycle.js';
import { MediaRouter } from '../routing/MediaRouter.js';
import type { ModuleServices, PluginModule } from '../plugins/PluginModule.js';

// B-194 (MR-005): ZA-SCC-SWA01's chain, Mic -> Audio Mixer -> SWA OUT (a transcoder) -> SWA Out
// (an SRT output), through the engine's own lifecycle, applier and router. A module with no
// input, or a mic without its device, has no bus channel: its connections wait for it.

/** Devices on the fake PipeWire graph. */
const present = new Set<string>();

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
        return this.services!.mediaRouter;
    }
    protected get id(): string {
        return this.services!.instanceId;
    }
}

/** Audio Input (302M): its build, and so its channel, only with its device present. */
class MicPlugin extends FakePlugin {
    private device = '';
    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.device = String(config.device);
    }
    async onStart(): Promise<void> {
        this.build();
    }
    /** The device watchdog's reconnect: the base's start, so the build. */
    plugged(): void {
        this.build();
    }
    private build(): void {
        if (present.has(this.device)) this.router.assignBusChannel(this.id);
    }
}

/** Holds the next start of a relay until released (a slow start under the lifecycle lock). */
let hold: Promise<void> | null = null;
/** Starts of a relay under way at once, at most. */
let overlap = { now: 0, max: 0 };

/** A mixer or a transcoder: idle with no input; with one, its build takes its output channel. */
class RelayPlugin extends FakePlugin {
    async onStart(): Promise<void> {
        overlap.max = Math.max(overlap.max, ++overlap.now);
        try {
            await hold;
            if (this.router.getModuleBusSources(this.id).length) {
                this.router.assignBusChannel(this.id, 'out');
            }
        } finally {
            overlap.now--;
        }
    }
}

/** An SRT output: what it was started with. */
class OutputPlugin extends FakePlugin {
    sources: string[] = [];
    async onStart(): Promise<void> {
        this.sources = this.router.getModuleBusSources(this.id).map((s) => s.sourceModuleId);
    }
}

const out302m = (id: string, ordered = false) => ({
    id,
    direction: 'output',
    streamType: 'audio/302m',
    ...(ordered ? { requiresOrderedApply: true } : {}),
});
const in302m = (id: string) => ({
    id,
    direction: 'input',
    streamType: 'audio/302m',
    maxConnections: -1,
});
const PLUGINS: Record<
    string,
    { ModuleClass: new () => PluginModule; manifest: { ports: object[] } }
> = {
    mic: { ModuleClass: MicPlugin, manifest: { ports: [out302m('audio-out')] } },
    relay: {
        ModuleClass: RelayPlugin,
        manifest: { ports: [in302m('in'), out302m('out', true)] },
    },
    output: { ModuleClass: OutputPlugin, manifest: { ports: [in302m('in')] } },
};

const edge = (src: string, srcPort: string, sink: string) => ({
    id: `${src}:${srcPort}-${sink}:in`,
    sourceModuleId: src,
    sourcePortId: srcPort,
    sinkModuleId: sink,
    sinkPortId: 'in',
});
/** The stored order on SWA01: the mixer's and the transcoder's (ordered) before the mic's. */
const CONNECTIONS = [
    edge('mixer', 'out', 'tc'),
    edge('tc', 'out', 'srt'),
    edge('mic', 'audio-out', 'mixer'),
];

function engine(device: string) {
    const config = {
        modules: {
            mic: { pluginId: 'mic', displayName: 'Mic 1', enabled: true, settings: { device } },
            mixer: { pluginId: 'relay', displayName: 'Audio Mixer', enabled: true, settings: {} },
            tc: { pluginId: 'relay', displayName: 'SWA OUT', enabled: true, settings: {} },
            srt: { pluginId: 'output', displayName: 'SWA Out', enabled: true, settings: {} },
        },
        connections: CONNECTIONS,
    };
    const loader = { get: (id: string) => PLUGINS[id], settle: async () => {} } as any;
    const pipeWire = {
        releaseAll: vi.fn(async () => {}),
        cleanupOrphans: vi.fn(async () => {}),
    } as any;
    const processManager = { releaseAll: vi.fn(async () => {}) } as any;
    const router = new MediaRouter();
    const modules = new ModuleManager(loader, pipeWire, router, processManager, {} as any);
    router.setDependencies(
        pipeWire,
        (id) => modules.get(id),
        (id) => ((config.modules as any)[id]?.displayName as string) ?? id,
    );
    const lifecycle = new ModuleLifecycle(modules, router, pipeWire, () => config, loader);
    return {
        router,
        modules,
        lifecycle,
        mic: () => modules.get('mic')!.getPlugin() as MicPlugin,
        srt: () => modules.get('srt')!.getPlugin() as OutputPlugin,
        live: () =>
            router
                .getConnections()
                .map((c) => c.id)
                .sort(),
    };
}

const ALL = CONNECTIONS.map((c) => c.id).sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('connections wait for their producer (B-194, MR-005)', { timeout: 20_000 }, () => {
    let lines: Array<{ level: number; name: string; msg: string }>;
    const errors = () => lines.filter((l) => l.level >= 50);
    const waits = () => lines.filter((l) => l.name === 'MediaRouter' && /waits for/.test(l.msg));

    beforeEach(() => {
        present.clear();
        hold = null;
        overlap = { now: 0, max: 0 };
        lines = [];
        setLogTap((l) => lines.push(JSON.parse(l)));
    });

    afterEach(() => setLogTap(null));

    it('an engine start logs no level-50 line and every connection comes up (SWA01, 31 Oct)', async () => {
        present.add('SSL2:Mic1');
        const e = engine('SSL2:Mic1');
        await e.lifecycle.startAll();
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));

        expect(errors()).toEqual([]);
        expect(lines.some((l) => /Connection failed/.test(l.msg))).toBe(false);
        // The mixer's and the transcoder's waited for their outputs, by name.
        expect(waits().map((l) => l.msg)).toEqual([
            'Connection [Audio Mixer → SWA OUT] waits for Audio Mixer: its output is not up yet',
            'Connection [SWA OUT → SWA Out] waits for SWA OUT: its output is not up yet',
        ]);
        expect(e.srt().sources).toEqual(['tc']);
        await e.lifecycle.stopAll();
    });

    it('a mic waiting minutes for its device: its connections wait, then come up when it is plugged in', async () => {
        const e = engine('SSL2:Mic1');
        await e.lifecycle.startAll();
        await sleep(50);
        expect(e.live()).toEqual([]);
        expect(errors()).toEqual([]);
        expect(waits().map((l) => l.msg)).toContain(
            'Connection [Mic 1 → Audio Mixer] waits for Mic 1: its output is not up yet',
        );
        // Event-driven, so nothing is retried meanwhile, however long it takes.
        const attempts = lines.length;
        await sleep(200);
        expect(lines.length).toBe(attempts);

        present.add('SSL2:Mic1');
        e.mic().plugged();
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));
        expect(e.srt().sources).toEqual(['tc']);
        expect(errors()).toEqual([]);
        await e.lifecycle.stopAll();
    });

    it('a device picked again and Restart: the mic opens it and its connections come up', async () => {
        present.add('SSL2:Mic1');
        const e = engine('ssl2_mono_in_S2_0_0'); // the scarthgap name (MR-004)
        await e.lifecycle.startAll();
        expect(e.live()).toEqual([]);

        await e.modules.get('mic')!.applyConfigUpdate({ device: 'SSL2:Mic1' });
        await e.lifecycle.restart('mic');
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));
        expect(errors()).toEqual([]);
        await e.lifecycle.stopAll();
    });

    it("a connection woken during another module's Restart runs after it, under the lifecycle lock", async () => {
        const e = engine('SSL2:Mic1');
        await e.lifecycle.startAll();
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        const restarting = e.lifecycle.restart('tc');
        await vi.waitFor(() => expect(overlap.now).toBe(1));

        present.add('SSL2:Mic1');
        e.mic().plugged();
        await sleep(100);
        // The mic's connection waits for the Restart: no mixer restart beside the transcoder's.
        expect(e.live()).toEqual([]);
        expect(overlap.max).toBe(1);

        hold = null;
        release();
        await restarting;
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));
        expect(overlap.max).toBe(1);
        expect(errors()).toEqual([]);
        await e.lifecycle.stopAll();
    });

    it('the mixer restarted outside the lifecycle as the mic comes up: the mic connects at its start (B-196)', async () => {
        const e = engine('SSL2:Mic1');
        await e.lifecycle.startAll();
        // A live connect into the mixer restarts it (MpegTsBusExecutor), not the lifecycle.
        const mixer = e.modules.get('mixer')!;
        let release!: () => void;
        hold = new Promise<void>((r) => (release = r));
        await mixer.stop();
        const starting = mixer.start();

        present.add('SSL2:Mic1');
        e.mic().plugged();
        await sleep(100);
        // Woken while the mixer was stopped: it keeps waiting, never starts the mixer itself.
        expect(e.live()).toEqual([]);
        expect(e.router.isConnectionWaiting('mic:audio-out-mixer:in')).toBe(true);
        expect(overlap.max).toBe(1);

        hold = null;
        release();
        await starting;
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));
        expect(e.srt().sources).toEqual(['tc']);
        expect(errors()).toEqual([]);
        await e.lifecycle.stopAll();
    });

    it('a Restart of the mixer while the mic waits: no error, still waiting, up at the plug', async () => {
        const e = engine('SSL2:Mic1');
        await e.lifecycle.startAll();
        await e.lifecycle.restart('mixer');
        expect(e.live()).toEqual([]);
        expect(e.router.isConnectionWaiting('mic:audio-out-mixer:in')).toBe(true);
        expect(errors()).toEqual([]);

        present.add('SSL2:Mic1');
        e.mic().plugged();
        await vi.waitFor(() => expect(e.live()).toEqual(ALL));
        expect(errors()).toEqual([]);
        await e.lifecycle.stopAll();
    });
});

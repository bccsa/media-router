import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** MR-003 / B-192 (ZA-SCC-SWA01): an Audio Output (302M) fed by four transcoders, only Master
 *  running, played nothing. The engine's routing, runner host and the module run here; only the
 *  GStreamer runner is faked, and each producer's edge socket is a real listener once it runs. */
const h = vi.hoisted(() => {
    /** The runner's done event for each tracked command it is sent. */
    const DONE: Record<string, string> = {
        bus_input_add: 'bus_input_add_done',
        bus_input_remove: 'bus_input_remove_done',
        set_property: 'property_set',
        get_property: 'property',
        track_throughput: 'tracking',
        get_throughput: 'throughput',
        get_stats: 'stats',
    };
    /** The runner process as the runner host drives it: it records the start it is given,
     *  answers every tracked command, and exits a tick after a stop, as a drained runner does. */
    class FakeRunner {
        static spawned: FakeRunner[] = [];
        readonly commands: Record<string, unknown>[] = [];
        startOpts: { pipeline: string; liveInputBranches?: string[] } | undefined;
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
            return 6000 + FakeRunner.spawned.indexOf(this);
        }
        start(opts: { pipeline: string; liveInputBranches?: string[] }): void {
            this.startOpts = opts;
            this.commands.push({ cmd: 'start' });
        }
        sendCommand(cmd: Record<string, unknown>): void {
            this.commands.push(cmd);
            const done = DONE[String(cmd.cmd)];
            if (!done || !cmd.id) return;
            setTimeout(() => this.options.onEvent({ event: done, id: cmd.id, name: cmd.name }), 0);
        }
    }
    return { FakeRunner };
});

vi.mock('../../../packages/engine/src/child-process/PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    PythonProcess: h.FakeRunner,
}));

import { MediaRouter, ModuleInstance, busEdgeSocketPath, shortHash } from '@media-router/engine';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

const SINK = 'aout-1';
const DEVICE = 'alsa_output.usb-Solid_State_Logic_SSL_2-00.HiFi__Line__sink';
/** Master, ENG IN, SWA IN, Chat IN. */
const PRODUCERS = ['tc-master', 'tc-eng', 'tc-swa', 'tc-chat'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(cond: () => boolean, budgetMs = 6000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(20);
    }
    return cond();
}

/** An Audio Transcoder as the router sees it: its gst child, and its edge sockets, which
 *  exist only while its pipeline is up (the runner binds them on `bus_attach`). */
class Producer {
    readonly running = true;
    readonly config = {};
    readonly child = { pipelineLaunchedAt: undefined as number | undefined, isRunning: false };
    private readonly edges = new Set<string>();
    private readonly servers = new Map<string, Server>();
    /** Its edge sockets are bound. */
    private up = false;

    constructor(readonly id: string) {}

    getChildProcess() {
        return this.child;
    }
    getBusAttachTarget() {
        return {
            sendBusAttach: (_tee: string, socket: string) => {
                this.edges.add(socket);
                if (this.up) void this.serve(socket);
            },
            sendBusDetach: (socket: string) => {
                this.edges.delete(socket);
                this.servers.get(socket)?.close();
                this.servers.delete(socket);
            },
        };
    }
    getBusStreamChannels() {
        return undefined;
    }
    getTimingSummary() {
        return undefined;
    }

    /** Launched (now, or at the launch it already has): its edge sockets bind. */
    async launch(): Promise<void> {
        this.child.pipelineLaunchedAt ??= Date.now();
        this.up = true;
        for (const s of this.edges) await this.serve(s);
    }
    /** Data flows: PLAYING, which GstPluginBase reports to the router. */
    async play(router: MediaRouter): Promise<void> {
        await this.launch();
        this.child.isRunning = true;
        router.onProducerPlaying(this.id);
    }
    /** Its pipeline goes away: the sockets close. */
    async die(): Promise<void> {
        this.up = false;
        this.child.isRunning = false;
        this.child.pipelineLaunchedAt = undefined;
        for (const srv of this.servers.values()) await new Promise((r) => srv.close(r));
        this.servers.clear();
    }
    private async serve(socket: string): Promise<void> {
        if (this.servers.has(socket)) return;
        const srv = createServer(() => {});
        this.servers.set(socket, srv);
        await new Promise<void>((resolve) => srv.listen(socket, () => resolve()));
    }
}

const connId = (p: string) => `${p}:out-0-${SINK}:audio-in`;
const binOf = (p: string) => `mixin_in_${shortHash(connId(p))}`;

describe(
    'Audio Output (302M) with four sources plays the ones that run (B-192, MR-003)',
    { timeout: 30_000 },
    () => {
        let dir: string;
        let router: MediaRouter;
        let producers: Map<string, Producer>;
        let sink: ModuleInstance;
        let plugin: AudioOutput302mModule;

        /** What the runner was told to do, over every launch. */
        const commands = (cmd: string) =>
            h.FakeRunner.spawned.flatMap((py) => py.commands.filter((c) => c.cmd === cmd));
        const launchedBins = (py: InstanceType<typeof h.FakeRunner>) =>
            [...(py.startOpts?.pipeline ?? '').matchAll(/\( name=(\S+) /g)].map((m) => m[1]);
        const runnerSide = (py: InstanceType<typeof h.FakeRunner>) => py.options.onEvent;

        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'mr-b192-'));
            vi.stubEnv('MR_BUS_SOCKET_DIR', dir);
            h.FakeRunner.spawned = [];

            router = new MediaRouter();
            producers = new Map(PRODUCERS.map((p) => [p, new Producer(p)]));
            plugin = new AudioOutput302mModule();
            const services = {
                instanceId: SINK,
                mediaRouter: router,
                pipeWire: {
                    hasDevice: () => true,
                    getDeviceInfo: () => ({ channels: 2, sampleRate: 48000 }),
                    releaseAll: vi.fn(async () => {}),
                },
                processManager: { releaseAll: vi.fn(async () => {}) },
                deviceProviders: {},
            } as any;
            sink = new ModuleInstance(
                SINK,
                'audio-output-302m',
                plugin,
                { device: DEVICE },
                services,
            );
            router.setDependencies({} as any, (id) =>
                id === SINK ? sink : (producers.get(id) as unknown as ModuleInstance),
            );
            router.registerPorts(SINK, [
                {
                    id: 'audio-in',
                    direction: 'input',
                    streamType: 'audio/302m',
                    label: 'Audio In',
                    maxConnections: -1,
                    acceptsStreamTypes: ['audio/302m'],
                },
            ]);
            for (const p of PRODUCERS) {
                router.registerPorts(p, [
                    { id: 'out-0', direction: 'output', streamType: 'audio/302m', label: 'Out' },
                ]);
                router.assignBusChannel(p, 'out-0');
            }
        });

        afterEach(async () => {
            await sink.stop();
            for (const p of producers.values()) await p.die();
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        });

        /** Engine start on SWA01: the output, then its four connections; only Master runs. */
        async function startWithMasterOnly(): Promise<InstanceType<typeof h.FakeRunner>> {
            await producers.get('tc-master')!.play(router);
            await sink.start();
            for (const p of PRODUCERS) await router.createConnection(p, 'out-0', SINK, 'audio-in');
            // The last restart's launch: all four wired, so all four named for containment.
            expect(
                await waitUntil(
                    () => h.FakeRunner.spawned.at(-1)?.startOpts?.liveInputBranches?.length === 4,
                ),
            ).toBe(true);
            const py = h.FakeRunner.spawned.at(-1)!;
            runnerSide(py)({ event: 'state_change', state: 'playing' });
            await waitUntil(() => plugin.getState().running && plugin.getState().ready);
            return py;
        }

        it('four sources, one running: the output launches with that one and plays it', async () => {
            const py = await startWithMasterOnly();

            // Launched with Master's branch alone; nothing in it waits for the other three.
            expect(launchedBins(py)).toEqual([binOf('tc-master')]);
            expect(py.startOpts!.pipeline).toContain(
                busEdgeSocketPath(
                    router.getBusChannel('tc-master', 'out-0')!.port,
                    connId('tc-master'),
                ),
            );
            expect(py.startOpts!.liveInputBranches).toEqual(PRODUCERS.map(binOf));
            const state = plugin.getState();
            expect(state.running).toBe(true);
            expect(state.health).toBe('warning');
            expect(state.error).toBe(
                'Input from tc-eng (audio-in), tc-swa (audio-in), tc-chat (audio-in) lost — continuing without it',
            );
            expect(state.error).not.toContain('Waiting for upstream');
        });

        it('a second source starting later joins the running mix: no relaunch, no restart', async () => {
            const py = await startWithMasterOnly();
            const spawned = h.FakeRunner.spawned.length;
            const child = plugin.getChildProcess();

            await producers.get('tc-eng')!.play(router);
            expect(
                await waitUntil(() =>
                    commands('bus_input_add').some((c) => c.name === binOf('tc-eng')),
                ),
            ).toBe(true);
            const add = commands('bus_input_add').find((c) => c.name === binOf('tc-eng'))!;
            expect(add.element).toBe('mixin');
            expect(String(add.description)).toContain(
                busEdgeSocketPath(router.getBusChannel('tc-eng', 'out-0')!.port, connId('tc-eng')),
            );
            await waitUntil(() => !String(plugin.getState().error).includes('tc-eng'));
            expect(plugin.getState().error).toBe(
                'Input from tc-swa (audio-in), tc-chat (audio-in) lost — continuing without it',
            );
            // Master was never interrupted: the same runner, the same launch.
            expect(h.FakeRunner.spawned.length).toBe(spawned);
            expect(plugin.getChildProcess()).toBe(child);
            expect(py.stop).not.toHaveBeenCalled();
            expect(commands('bus_input_remove').map((c) => c.name)).not.toContain(
                binOf('tc-master'),
            );
        });

        it('a source launched before the output, its socket up only later, joins when it plays', async () => {
            // tc-swa's pipeline was already up (gated on its SRT input) when the output launched,
            // but its edge socket was not: the output went without it, and rule 4 sees nothing stale.
            const swa = producers.get('tc-swa')!;
            swa.child.pipelineLaunchedAt = Date.now() - 60_000;
            await startWithMasterOnly();
            const spawned = h.FakeRunner.spawned.length;

            await swa.play(router);
            expect(
                await waitUntil(() =>
                    commands('bus_input_add').some((c) => c.name === binOf('tc-swa')),
                ),
            ).toBe(true);
            expect(commands('bus_input_remove').map((c) => c.name)).not.toContain(binOf('tc-swa'));
            expect(h.FakeRunner.spawned.length).toBe(spawned);
        });

        it('a source that plays while the output is still starting joins when the output plays', async () => {
            const chat = producers.get('tc-chat')!;
            chat.child.pipelineLaunchedAt = Date.now() - 60_000;
            await producers.get('tc-master')!.play(router);
            await sink.start();
            for (const p of PRODUCERS) await router.createConnection(p, 'out-0', SINK, 'audio-in');
            await waitUntil(
                () => h.FakeRunner.spawned.at(-1)?.startOpts?.liveInputBranches?.length === 4,
            );
            const py = h.FakeRunner.spawned.at(-1)!;
            expect(launchedBins(py)).toEqual([binOf('tc-master')]);

            // Its PLAYING comes before the output's: nothing can be added to a pipeline not playing.
            await chat.play(router);
            await sleep(300);
            expect(commands('bus_input_add').some((c) => c.name === binOf('tc-chat'))).toBe(false);

            runnerSide(py)({ event: 'state_change', state: 'playing' });
            expect(
                await waitUntil(() =>
                    commands('bus_input_add').some((c) => c.name === binOf('tc-chat')),
                ),
            ).toBe(true);
            expect(h.FakeRunner.spawned.at(-1)).toBe(py);
        });

        it('a source going away does not stop the output: Master plays on, the loss is named', async () => {
            const py = await startWithMasterOnly();
            const eng = producers.get('tc-eng')!;
            await eng.play(router);
            await waitUntil(() => !String(plugin.getState().error).includes('tc-eng'));
            const spawned = h.FakeRunner.spawned.length;

            // ENG IN's transcoder dies: its socket closes and the runner drops just that branch.
            await eng.die();
            runnerSide(py)({
                event: 'input_branch_lost',
                name: binOf('tc-eng'),
                message: `live input ${binOf('tc-eng')} lost (unixfdsrc1): Internal data stream error.`,
            });
            await waitUntil(() => String(plugin.getState().error).includes('tc-eng'));

            expect(plugin.getState().running).toBe(true);
            expect(plugin.getState().error).toBe(
                'Input from tc-swa (audio-in), tc-chat (audio-in), tc-eng (audio-in) lost — continuing without it',
            );
            expect(h.FakeRunner.spawned.length).toBe(spawned);
            expect(py.stop).not.toHaveBeenCalled();
            expect(commands('bus_input_remove').map((c) => c.name)).not.toContain(
                binOf('tc-master'),
            );
        });
    },
);

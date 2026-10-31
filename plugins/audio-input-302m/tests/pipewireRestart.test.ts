import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-195 on a real PipeWire: a private daemon and pipewire-pulse (own runtime dir, no D-Bus, ALSA or
 *  WirePlumber), the real Audio Input (302M) on the native runner, real pactl and pw-link. Skipped,
 *  saying why, where PipeWire, its GStreamer plugin, the elements or the runner are missing. */

import { GstChildProcess, ModuleInstance, PipeWireManager } from '@media-router/engine';
import { setLogTap } from '@media-router/shared-types';
import { AudioInput302mModule } from '../engine/AudioInput302mModule.js';

const DEVICE = 'c18_mic';
const RUNNER = join(__dirname, '../../../packages/engine/native/mr-gst-runner/mr-gst-runner');
const ELEMENTS = ['pipewiresrc', 'avenc_s302m', 'mpegtsmux', 'level', 'capssetter'];

const onPath = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

/** Never the user's registry: the gate's own, or one of this run's. */
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b195-registry-${process.pid}.bin`);

const skip: string | null = (() => {
    const missing = ['pipewire', 'pactl', 'pw-link', 'pw-dump', 'gst-inspect-1.0'].filter(
        (b) => !onPath(b),
    );
    if (missing.length) return `not installed: ${missing.join(', ')}`;
    if (!existsSync(RUNNER)) return 'mr-gst-runner not built (make native)';
    const env = { ...process.env, GST_REGISTRY: registry };
    const absent = ELEMENTS.filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
})();

/** No D-Bus, nothing locked in memory, errors only; `extra` joins these properties. */
const common = (extra = '') => `
context.properties = { support.dbus = false mem.allow-mlock = false log.level = 1 ${extra} }
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    audio.adapt = audioconvert/libspa-audioconvert
    support.* = support/libspa-support
}`;

/** The daemon: what a client needs, a driver, and the virtual source the mic captures. */
const DAEMON_CONF = `${common('core.daemon = true core.name = pipewire-0 default.clock.rate = 48000')}
context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-access
      args = { access.socket = { pipewire-0 = "unrestricted" pipewire-0-manager = "unrestricted" } } }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-spa-node-factory }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-client-device }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-link-factory }
]
context.objects = [
    { factory = spa-node-factory
      args = { factory.name = support.node.driver node.name = Dummy-Driver priority.driver = 20000 } }
    { factory = adapter
      args = { factory.name = support.null-audio-sink node.name = ${DEVICE}
               media.class = Audio/Source/Virtual audio.position = [ FL FR ]
               node.driver = true priority.driver = 30000 object.linger = true
               adapter.auto-port-config = { mode = dsp monitor = true position = preserve } } }
]
`;

const pulseConf = (server: string) => `${common()}
context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-protocol-pulse args = { server.address = [ "${server}" ] } }
]
`;

/** A private PipeWire: the daemon with one virtual 2-channel source, and pipewire-pulse. */
class PrivatePipeWire {
    readonly root = mkdtempSync(join(tmpdir(), 'mr-b195-pw-'));
    private readonly conf = join(this.root, 'conf');
    private readonly run = join(this.root, 'run');
    private daemon: ChildProcess | null = null;
    private pulse: ChildProcess | null = null;
    readonly env: Record<string, string> = {
        XDG_RUNTIME_DIR: this.run,
        PIPEWIRE_RUNTIME_DIR: this.run,
        PULSE_RUNTIME_PATH: join(this.run, 'pulse'),
        PULSE_SERVER: `unix:${join(this.run, 'pulse', 'native')}`,
        PIPEWIRE_CONFIG_DIR: this.conf,
        XDG_CONFIG_HOME: join(this.root, 'xdg'),
        XDG_STATE_HOME: join(this.root, 'state'),
    };

    constructor() {
        for (const d of [
            this.conf,
            join(this.run, 'pulse'),
            join(this.root, 'xdg'),
            join(this.root, 'state'),
        ])
            mkdirSync(d, { recursive: true, mode: 0o700 });
        // No session manager: client streams make their own ports (the image's WirePlumber does).
        writeFileSync(
            join(this.conf, 'client.conf'),
            readFileSync('/usr/share/pipewire/client.conf', 'utf8').replace(
                /^stream\.properties = \{/m,
                'stream.properties = {\n    adapter.auto-port-config = { mode = dsp }',
            ),
        );
        writeFileSync(join(this.conf, 'pipewire.conf'), DAEMON_CONF);
        writeFileSync(join(this.conf, 'pipewire-pulse.conf'), pulseConf(this.env.PULSE_SERVER));
    }

    private childEnv(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
        delete env.DBUS_SESSION_BUS_ADDRESS;
        delete env.PIPEWIRE_REMOTE;
        return env;
    }

    private async launch(conf: string, socket: string): Promise<ChildProcess> {
        const child = spawn('pipewire', ['-c', join(this.conf, conf)], {
            env: this.childEnv(),
            stdio: 'ignore',
        });
        await until(() => existsSync(socket), 5000);
        return child;
    }

    async start(): Promise<void> {
        this.daemon = await this.launch('pipewire.conf', join(this.run, 'pipewire-0'));
        this.pulse = await this.launch('pipewire-pulse.conf', join(this.run, 'pulse', 'native'));
        await until(() => pactlOk(this.childEnv()), 5000);
    }

    /** As the Device Manager's restart stops them: pipewire-pulse first, then the daemon. */
    async stop(): Promise<void> {
        for (const child of [this.pulse, this.daemon]) {
            if (!child || child.exitCode !== null) continue;
            const exited = new Promise((r) => child.once('exit', r));
            child.kill('SIGTERM');
            await exited;
        }
        this.pulse = this.daemon = null;
        rmSync(join(this.run, 'pipewire-0'), { force: true });
        rmSync(join(this.run, 'pulse', 'native'), { force: true });
    }

    /** Is a node of that name in the graph (`pw-dump`)? */
    hasNode(name: string): boolean {
        const r = spawnSync('pw-dump', [], {
            env: this.childEnv(),
            encoding: 'utf8',
            timeout: 5000,
        });
        return r.status === 0 && r.stdout.includes(`"node.name": "${name}"`);
    }

    remove(): void {
        rmSync(this.root, { recursive: true, force: true });
    }
}

const pactlOk = (env: NodeJS.ProcessEnv) =>
    spawnSync('pactl', ['info'], { env, stdio: 'ignore', timeout: 3000 }).status === 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(100);
    }
    return cond();
}

beforeAll(() => {
    if (skip) console.warn(`[B-195] real PipeWire restart test skipped — ${skip}`);
});

describe.skipIf(skip !== null)(
    'Audio Input (302M) on a real PipeWire that restarts (B-195)',
    { timeout: 120_000 },
    () => {
        let pw: PrivatePipeWire;
        let instance: ModuleInstance;
        let module: AudioInput302mModule;
        const saved: Record<string, string | undefined> = {};
        const readings: number[] = [];
        const lines: Array<{ time: string; name: string; msg: string }> = [];
        /** Meter readings in the last `ms`: the capture delivers (silence included). */
        const flowing = (ms = 2000) => readings.filter((t) => Date.now() - t < ms).length >= 2;
        const state = () => module.getState();

        beforeAll(async () => {
            pw = new PrivatePipeWire();
            const env = { ...pw.env, GST_REGISTRY: registry };
            for (const [k, v] of Object.entries(env)) {
                saved[k] = process.env[k];
                process.env[k] = v;
            }
            for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'PIPEWIRE_REMOTE']) {
                saved[k] = process.env[k];
                delete process.env[k];
            }
            setLogTap((l) => lines.push(JSON.parse(l)));
            await pw.start();
            module = new AudioInput302mModule();
            module.on('vuData', () => readings.push(Date.now()));
            instance = new ModuleInstance(
                'b195-mic',
                'audio-input-302m',
                module,
                { device: DEVICE, channels: 2 },
                {
                    instanceId: 'b195-mic',
                    pipeWire: new PipeWireManager(),
                    mediaRouter: {
                        assignBusChannel: () => ({ port: 41950 }),
                        releaseAllBusChannelsFor: () => {},
                        onProducerPlaying: () => {},
                        getModuleBusSources: () => [],
                        hasStoredEdge: () => false,
                    },
                    processManager: { releaseAll: async () => {} },
                    deviceProviders: {},
                } as any,
            );
            await instance.start();
            expect(await until(() => flowing() && state().health === 'ok', 60_000)).toBe(true);
        }, 120_000);

        afterAll(async () => {
            await instance?.stop();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b195-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        it('restarted under the capture (~0.2 s down): a warning naming it, then capturing again within 10 s', async () => {
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(true);
            await pw.stop();
            await sleep(200);
            await pw.start();
            const back = Date.now();
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(false); // the field's after-1.txt
            const warned = until(() => state().health === 'warning', 10_000);
            expect(await warned).toBe(true);
            expect(state().error).toMatch(/^PipeWire restarted — rebuilding the stream/);
            expect(await until(() => flowing() && state().health === 'ok', 10_000)).toBe(true);
            console.log(
                `[B-195] restart: capturing again ${Date.now() - back} ms after PipeWire returned`,
            );
            expect(Date.now() - back).toBeLessThan(10_000);
            expect(pw.hasNode('MR_PW_b195-mic')).toBe(true);
        });

        it('stopped 20 s: one teardown, no rebuild and no log line while down, capturing again within 10 s of its return', async () => {
            const starts = vi.spyOn(GstChildProcess.prototype, 'start');
            await pw.stop();
            expect(await until(() => state().health === 'warning', 10_000)).toBe(true);
            expect(state().error).toMatch(/^PipeWire is not answering — rebuilding the stream/);
            const quiet = lines.length;
            const stderr = vi.spyOn(process.stderr, 'write');
            await sleep(15_000);
            expect(starts).not.toHaveBeenCalled();
            expect(lines.slice(quiet).map((l) => `${l.name}: ${l.msg}`)).toEqual([]);
            // Nor pactl's own complaint, once per call, into the engine's stderr (the journal).
            expect(
                stderr.mock.calls
                    .map((c) => String(c[0]))
                    .filter((t) => /Connection (failure|refused)/.test(t)),
            ).toEqual([]);
            stderr.mockRestore();
            await pw.start();
            const back = Date.now();
            expect(await until(() => flowing() && state().health === 'ok', 10_000)).toBe(true);
            console.log(
                `[B-195] outage: capturing again ${Date.now() - back} ms after PipeWire returned`,
            );
            expect(Date.now() - back).toBeLessThan(10_000);
            expect(starts).toHaveBeenCalledTimes(1);
            starts.mockRestore();
        });
    },
);

// The real-PipeWire tests' PipeWire (B-195): a daemon and pipewire-pulse in their own runtime dir
// (no D-Bus, ALSA or WirePlumber), never the desktop session's; virtual devices stand in for real.
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstChildProcess } from '../../child-process/GstChildProcess.js';

/** The native runner the modules run on here. */
export const NATIVE_RUNNER = join(__dirname, '../../../native/mr-gst-runner/mr-gst-runner');

const onPath = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;

/** Why a real-PipeWire test cannot run here (null: it can): a PipeWire tool, the native runner or
 *  one of `elements`, looked up in `registry` (the gate's or a temp one, never the user's). */
export function realPipeWireSkip(elements: string[], registry: string): string | null {
    const missing = ['pipewire', 'pactl', 'pw-link', 'pw-dump', 'gst-inspect-1.0'].filter(
        (b) => !onPath(b),
    );
    if (missing.length) return `not installed: ${missing.join(', ')}`;
    if (!existsSync(NATIVE_RUNNER)) return 'mr-gst-runner not built (make native)';
    const env = { ...process.env, GST_REGISTRY: registry };
    const absent = elements.filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
}

/** The virtual 2-channel devices the daemon creates, listed by pactl as real ones are. */
export interface PrivatePipeWireDevices {
    sources?: string[];
    sinks?: string[];
    /** Sinks of that many AUX-named ports, as a desk's USB card (B-214). */
    auxSinks?: Record<string, number>;
}

/** No D-Bus, nothing locked in memory, errors only; `extra` joins these properties. */
const common = (extra = '') => `
context.properties = { support.dbus = false mem.allow-mlock = false log.level = 1 ${extra} }
context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    audio.adapt = audioconvert/libspa-audioconvert
    support.* = support/libspa-support
}`;

const device = (name: string, mediaClass: string, priority: number, positions = 'FL FR') => `
    { factory = adapter
      args = { factory.name = support.null-audio-sink node.name = ${name}
               media.class = ${mediaClass} audio.position = [ ${positions} ]
               node.driver = true priority.driver = ${priority} object.linger = true
               adapter.auto-port-config = { mode = dsp monitor = true position = preserve } } }`;

/** `AUX0 AUX1 …`: the positions of a card whose ports are AUX-named. */
export const auxPositions = (channels: number): string[] =>
    Array.from({ length: channels }, (_, i) => `AUX${i}`);

const devicesConf = (devices: PrivatePipeWireDevices) =>
    [
        ...(devices.sources ?? []).map((n, i) => device(n, 'Audio/Source/Virtual', 30000 - i)),
        ...(devices.sinks ?? []).map((n, i) => device(n, 'Audio/Sink', 29000 - i)),
        ...Object.entries(devices.auxSinks ?? {}).map(([n, ch], i) =>
            device(n, 'Audio/Sink', 28000 - i, auxPositions(ch).join(' ')),
        ),
    ].join('');

/** The daemon: what a client needs, a driver, and the virtual devices. */
const daemonConf = (devices: PrivatePipeWireDevices) => `${common(
    'core.daemon = true core.name = pipewire-0 default.clock.rate = 48000',
)}
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
${devicesConf(devices)}
]
`;

/** pipewire-pulse; its streams make their own ports, as the client streams do (no WirePlumber). */
const pulseConf = (server: string) => `${common()}
context.modules = [
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }
    { name = libpipewire-module-metadata }
    { name = libpipewire-module-protocol-pulse args = { server.address = [ "${server}" ] } }
]
stream.properties = { adapter.auto-port-config = { mode = dsp } }
`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return true;
        await sleep(100);
    }
    return cond();
}

/** Its sockets, and the bus edges tests put under it, must fit sun_path (108 bytes): short. */
const SHORT_TMP = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();

/** A private PipeWire: the daemon with its virtual devices, and pipewire-pulse. */
export class PrivatePipeWire {
    readonly root = mkdtempSync(join(SHORT_TMP, 'mr-pw-'));
    private readonly conf = join(this.root, 'conf');
    private readonly run = join(this.root, 'run');
    private daemon: ChildProcess | null = null;
    private pulse: ChildProcess | null = null;
    private saved: Record<string, string | undefined> | null = null;
    /** Its virtual devices' node names. */
    readonly devices: string[];
    readonly env: Record<string, string> = {
        XDG_RUNTIME_DIR: this.run,
        PIPEWIRE_RUNTIME_DIR: this.run,
        PULSE_RUNTIME_PATH: join(this.run, 'pulse'),
        PULSE_SERVER: `unix:${join(this.run, 'pulse', 'native')}`,
        PIPEWIRE_CONFIG_DIR: this.conf,
        XDG_CONFIG_HOME: join(this.root, 'xdg'),
        XDG_STATE_HOME: join(this.root, 'state'),
    };

    constructor(devices: PrivatePipeWireDevices) {
        this.devices = [
            ...(devices.sources ?? []),
            ...(devices.sinks ?? []),
            ...Object.keys(devices.auxSinks ?? {}),
        ];
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
        writeFileSync(join(this.conf, 'pipewire.conf'), daemonConf(devices));
        writeFileSync(join(this.conf, 'pipewire-pulse.conf'), pulseConf(this.env.PULSE_SERVER));
    }

    childEnv(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = { ...process.env, ...this.env };
        delete env.DBUS_SESSION_BUS_ADDRESS;
        delete env.PIPEWIRE_REMOTE;
        return env;
    }

    /** This process and the runners it starts on this PipeWire and `registry`, until `leave`. */
    enter(registry: string): void {
        const env: Record<string, string | undefined> = { ...this.env, GST_REGISTRY: registry };
        env.DBUS_SESSION_BUS_ADDRESS = env.PIPEWIRE_REMOTE = undefined;
        this.saved = {};
        for (const [k, v] of Object.entries(env)) {
            this.saved[k] = process.env[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }

    leave(): void {
        for (const [k, v] of Object.entries(this.saved ?? {})) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        this.saved = null;
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
        await until(
            () =>
                spawnSync('pactl', ['info'], {
                    env: this.childEnv(),
                    stdio: 'ignore',
                    timeout: 3000,
                }).status === 0,
            5000,
        );
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

    /** A PipeWire tool's output, without blocking the modules under test; '' when it fails. */
    tool(bin: 'pactl' | 'pw-link', args: string[]): Promise<string> {
        return new Promise((resolve) =>
            execFile(bin, args, { env: this.childEnv(), timeout: 3000 }, (err, stdout) =>
                resolve(err ? '' : String(stdout)),
            ),
        );
    }

    remove(): void {
        rmSync(this.root, { recursive: true, force: true });
    }
}

/**
 * WirePlumber's part for playback streams, which this PipeWire runs without: every `periodMs`,
 * each stream node's output ports are linked in order to `sink`'s playback ports (`positions`,
 * FL FR by default). Returns the stop, which resolves once the loop has ended.
 */
export function linkPlaybackStreams(
    pw: PrivatePipeWire,
    sink: string,
    periodMs = 250,
    positions = ['FL', 'FR'],
): () => Promise<void> {
    let running = true;
    const playback = positions.map((p) => `${sink}:playback_${p}`);
    const loop = (async () => {
        while (running) {
            const outputs = (await pw.tool('pw-link', ['-o'])).split('\n').filter(Boolean);
            const links = await pw.tool('pw-link', ['-l']);
            const byNode = new Map<string, string[]>();
            for (const port of outputs) {
                const node = port.slice(0, port.lastIndexOf(':'));
                if (pw.devices.includes(node)) continue;
                byNode.set(node, [...(byNode.get(node) ?? []), port].sort());
            }
            for (const ports of byNode.values()) {
                for (const [i, port] of ports.slice(0, playback.length).entries()) {
                    if (!links.includes(`${port}\n  |-> ${playback[i]}`)) {
                        await pw.tool('pw-link', [port, playback[i]]);
                    }
                }
            }
            await sleep(periodMs);
        }
    })();
    return async () => {
        running = false;
        await loop;
    };
}

/** What reaches `sink`: its monitor recorded to `file` (S16LE, stereo, 48 kHz), linked by hand
 *  as WirePlumber would (B-197). Times are seconds of recording; `at()` is now. */
export class MonitorRecorder {
    private running = true;
    private constructor(
        private readonly rec: GstChildProcess,
        private readonly file: string,
        private readonly loop: Promise<void>,
        private readonly stopLoop: () => void,
    ) {}

    static async start(pw: PrivatePipeWire, sink: string, file: string): Promise<MonitorRecorder> {
        let running = true;
        const loop = (async () => {
            while (running) {
                const inputs = (await pw.tool('pw-link', ['-i'])).split('\n').filter(Boolean);
                const links = await pw.tool('pw-link', ['-l']);
                for (const port of inputs) {
                    if (pw.devices.includes(port.slice(0, port.lastIndexOf(':')))) continue;
                    const ch = /_(FL|FR)$/.exec(port)?.[1];
                    const from = `${sink}:monitor_${ch}`;
                    if (ch && !links.includes(`${from}\n  |-> ${port}`)) {
                        await pw.tool('pw-link', [from, port]);
                    }
                }
                await sleep(250);
            }
        })();
        const rec = new GstChildProcess();
        await rec.start({
            pipeline:
                `pulsesrc device=${sink}.monitor buffer-time=20000 latency-time=10000` +
                ' ! audio/x-raw,format=S16LE,rate=48000,channels=2' +
                ` ! filesink location=${file} buffer-mode=unbuffered`,
        });
        const r = new MonitorRecorder(rec, file, loop, () => {
            running = false;
        });
        if (!(await until(() => r.at() > 0.5, 10_000))) throw new Error('monitor not recording');
        return r;
    }

    /** Seconds recorded so far. */
    at(): number {
        return existsSync(this.file) ? statSync(this.file).size / 192_000 : 0;
    }

    /** Per 10 ms window of [fromS, toS): does channel `ch` carry more than -40 dBFS? */
    windows(ch: 0 | 1, fromS: number, toS: number): boolean[] {
        const buf = readFileSync(this.file);
        const out: boolean[] = [];
        const last = Math.min(Math.floor(toS * 100), Math.floor(buf.length / 1920));
        for (let w = Math.max(0, Math.floor(fromS * 100)); w < last; w++) {
            let sum = 0;
            for (let i = w * 480; i < (w + 1) * 480; i++) {
                const x = buf.readInt16LE(i * 4 + ch * 2) / 32768;
                sum += x * x;
            }
            out.push(Math.sqrt(sum / 480) > 0.01);
        }
        return out;
    }

    /** The share of [fromS, toS) in which channel `ch` sounds. */
    presence(ch: 0 | 1, fromS: number, toS: number): number {
        const w = this.windows(ch, fromS, toS);
        return w.length ? w.filter(Boolean).length / w.length : 0;
    }

    /** The longest silence on channel `ch` within [fromS, toS), in ms. */
    longestGapMs(ch: 0 | 1, fromS: number, toS: number): number {
        let longest = 0;
        let run = 0;
        for (const on of this.windows(ch, fromS, toS)) {
            run = on ? 0 : run + 1;
            longest = Math.max(longest, run);
        }
        return longest * 10;
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.stopLoop();
        await this.loop;
        await this.rec.destroy();
    }
}

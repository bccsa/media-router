import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstChildProcess } from '../child-process/GstChildProcess.js';
import { resolveNativeRunner } from '../child-process/nativeRunner.js';
import { pulsePinnedStreamProps } from '../plugins/pulseStreamProps.js';
import { PaCommandQueue } from './PaCommandQueue.js';
import { pinPulseServer, pulseServerAddress } from './pulseServer.js';

describe('pulseServerAddress (B-199)', () => {
    it('is the per-user socket libpulse tries first, $XDG_RUNTIME_DIR/pulse/native', () => {
        expect(pulseServerAddress({ XDG_RUNTIME_DIR: '/run/user/1001' })).toBe(
            'unix:/run/user/1001/pulse/native',
        );
    });

    it('PULSE_RUNTIME_PATH comes first, as in libpulse; without either, /run/user/<uid>', () => {
        const env = { PULSE_RUNTIME_PATH: '/srv/pulse', XDG_RUNTIME_DIR: '/run/user/1001' };
        expect(pulseServerAddress(env)).toBe('unix:/srv/pulse/native');
        expect(pulseServerAddress({}, 1001)).toBe('unix:/run/user/1001/pulse/native');
    });
});

describe('pinPulseServer (B-199)', () => {
    it('names that socket, and keeps a server already named: either turns autospawn off', () => {
        const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: '/run/user/1001' };
        pinPulseServer(env);
        expect(env.PULSE_SERVER).toBe('unix:/run/user/1001/pulse/native');
        const named: NodeJS.ProcessEnv = {
            XDG_RUNTIME_DIR: '/run/user/1001',
            PULSE_SERVER: 'unix:/x',
        };
        pinPulseServer(named);
        expect(named.PULSE_SERVER).toBe('unix:/x');
    });
});

// The field's MR-028 without PipeWire: a private runtime dir (no server in it), a stand-in daemon.
// libpulse execs its daemon by absolute path, never from PATH: PULSE_BINARY names the stand-in. The
// image's libpulse autospawns by default; this Pi's Debian one does not, so a client.conf says yes.
const root = mkdtempSync(join(tmpdir(), 'mr-b199-'));
const run = join(root, 'run');
const spawned = join(root, 'spawned');
const daemon = join(root, 'pulseaudio');
writeFileSync(daemon, `#!/bin/sh\necho "$*" >> '${spawned}'\nexit 1\n`, { mode: 0o755 });
writeFileSync(join(root, 'client.conf'), 'autospawn = yes\n');
/** Never the user's registry: the gate's own, or this run's. */
const registry = process.env.GST_REGISTRY ?? join(root, 'registry.bin');
const runners = resolveNativeRunner() ? (['native', 'python'] as const) : (['python'] as const);

function skipReason(): string | null {
    if (process.getuid?.() === 0) return 'running as root: libpulse never autospawns for root';
    if (spawnSync('sh', ['-c', 'command -v pactl']).status !== 0) return 'pactl not installed';
    if (existsSync('/var/run/pulse/native')) return 'a system-wide PulseAudio answers here';
    if (spawnSync(daemon, ['probe']).status !== 1) return `${tmpdir()} cannot run the stand-in`;
    rmSync(spawned, { force: true });
    const env = { ...process.env, GST_REGISTRY: registry };
    const absent = ['pulsesrc', 'pulsesink', 'audiotestsrc', 'fakesink'].filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
}
const skip = skipReason();

/** The stand-in's calls: one line per daemon a client tried to start. */
const calls = () => (existsSync(spawned) ? readFileSync(spawned, 'utf8').trim().split('\n') : []);

/** A runner pipeline's element failure, as the engine's runner host reports it. */
async function runnerFailure(pipeline: string, runner: 'native' | 'python'): Promise<string> {
    const child = new GstChildProcess();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const failed = new Promise<string>((resolve) => {
            child.on('error', (e: { element?: string; message?: string }) => {
                if (e.element) resolve(`${runner} ${e.element}: ${e.message}`);
            });
            timer = setTimeout(() => resolve(`${runner}: no element error within 20 s`), 20_000);
        });
        await child.start({ pipeline, runner });
        return await failed;
    } finally {
        clearTimeout(timer);
        await child.destroy();
    }
}

/** Every PulseAudio client the engine starts, once each, with no server reachable: their errors. */
async function everyClient(): Promise<string[]> {
    const pa = new PaCommandQueue(0);
    const failures = [
        await pa.execImmediateAsync(['list', 'short', 'sinks']).catch(String),
        await pa.execImmediateAsync(['info']).catch(String),
        await pa.exec(['set-sink-volume', 'b199', '100%']).catch(String),
    ];
    for (const runner of runners) {
        const props = pulsePinnedStreamProps();
        failures.push(
            await runnerFailure(`pulsesrc device=b199.monitor ${props} ! fakesink`, runner),
        );
        failures.push(await runnerFailure(`audiotestsrc ! pulsesink device=b199 ${props}`, runner));
    }
    return failures;
}

describe.skipIf(skip !== null)(
    'no PulseAudio daemon of its own while PipeWire is down (B-199, MR-028)',
    { timeout: 120_000 },
    () => {
        const saved: Record<string, string | undefined> = {};
        /** Sets, or with undefined deletes, a variable of this process's env until afterAll. */
        const setEnv = (k: string, v: string | undefined) => {
            if (!(k in saved)) saved[k] = process.env[k];
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        };

        beforeAll(() => {
            mkdirSync(run, { mode: 0o700 });
            setEnv('XDG_RUNTIME_DIR', run);
            setEnv('PULSE_RUNTIME_PATH', undefined);
            setEnv('PULSE_CLIENTCONFIG', join(root, 'client.conf'));
            setEnv('PULSE_BINARY', daemon);
            setEnv('GST_REGISTRY', registry);
            setEnv('DISPLAY', undefined); // libpulse would read a server from the X11 root window
        });

        afterAll(() => {
            for (const [k, v] of Object.entries(saved)) setEnv(k, v);
        });

        it('with no server named (the field), pactl and a pulsesrc start a daemon: the rig sees it', async () => {
            setEnv('PULSE_SERVER', undefined);
            const failures = await everyClient();
            for (const f of failures) expect(f).toMatch(/Connection refused/);
            // One `pulseaudio --start` per pactl and pulsesrc; pulsesink asks libpulse for none.
            expect(calls()).toHaveLength(3 + runners.length);
            for (const c of calls()) expect(c).toMatch(/^--start\b/);
            rmSync(spawned, { force: true });
        });

        it('pinned as the engine does, every client fails as before and none starts a daemon', async () => {
            setEnv('PULSE_SERVER', undefined);
            pinPulseServer();
            expect(process.env.PULSE_SERVER).toBe(`unix:${run}/pulse/native`);
            const failures = await everyClient();
            for (const f of failures) expect(f).toMatch(/Connection refused/);
            expect(failures).toHaveLength(3 + 2 * runners.length);
            expect(calls()).toEqual([]);
        });
    },
);

beforeAll(() => {
    if (skip) console.warn(`[B-199] PulseAudio autospawn test skipped — ${skip}`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

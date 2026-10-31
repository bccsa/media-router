import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** MR-021 / B-195 (ZA-SCC-SWA01, 31 Oct): after the Device Manager restarted PipeWire both captures
 *  died without a word and stayed "ok". The module, its ModuleInstance and the runner host are
 *  real here; the runner process and PipeWire are faked. */
const h = vi.hoisted(() => {
    /** The runner process as the host drives it: records its start, exits a tick after a stop. */
    class FakeRunner {
        static spawned: FakeRunner[] = [];
        startOpts: { pipeline: string; eosDrain?: boolean } | undefined;
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
        }
        sendCommand(): void {}
    }
    return { FakeRunner };
});

vi.mock('../../../packages/engine/src/child-process/PythonProcess.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    PythonProcess: h.FakeRunner,
}));

import { ModuleInstance, PIPEWIRE_CAPTURE_STALL_MS } from '@media-router/engine';
import { AudioInput302mModule } from './AudioInput302mModule.js';

const MIC1 = 'alsa_input.usb-Solid_State_Logic_SSL_2-00.HiFi__Mic1__source';
const RESTARTED =
    'PipeWire restarted — rebuilding the stream once PipeWire and the device are back';

/** What `pactl` would say: the device listed, PipeWire answering, the daemon's cookie. */
const pw = { present: true, up: true, cookie: 'a1' };
const runners = () => h.FakeRunner.spawned;
const last = () => runners().at(-1)!;

/** Every line the module and its watchdog log. */
const lines: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = [];
const logger = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error'].map((level) => [
        level,
        (obj: Record<string, unknown>, msg: string) => lines.push({ level, msg, obj }),
    ]),
);

async function mic1() {
    const module = new AudioInput302mModule() as any;
    module.log = logger; // kept by onInit: a logger is made once per instance
    // pw-dump/pw-link stand-ins: the stream's two ports and the mono source's one.
    module.linkDeps = {
        dump: vi.fn(async () => [
            { id: 55, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': MIC1 } } },
            {
                id: 400,
                type: 'PipeWire:Interface:Node',
                info: { props: { 'node.name': 'MR_PW_ain-1' } },
            },
            {
                id: 100,
                type: 'PipeWire:Interface:Port',
                info: {
                    direction: 'output',
                    props: { 'node.id': 55, 'port.id': 0, 'port.name': 'capture_MONO' },
                },
            },
            ...[0, 1].map((i) => ({
                id: 300 + i,
                type: 'PipeWire:Interface:Port',
                info: {
                    direction: 'input',
                    props: { 'node.id': 400, 'port.id': i, 'port.name': `input_${i + 1}` },
                },
            })),
        ]),
        link: vi.fn(async () => undefined),
    };
    const services = {
        instanceId: 'ain-1',
        pipeWire: {
            hasDevice: (name: string) => pw.up && pw.present && name === MIC1,
            daemonInstance: () => (pw.up ? pw.cookie : null),
            isAvailable: () => pw.up,
            getDeviceInfo: () => ({ channels: 1, sampleRate: 48000 }),
            releaseAll: vi.fn(async () => {}),
        },
        mediaRouter: {
            assignBusChannel: () => ({ port: 41000 }),
            releaseAllBusChannelsFor: vi.fn(),
            onProducerPlaying: vi.fn(),
            getModuleBusSources: () => [],
            hasStoredEdge: () => false,
        },
        processManager: { releaseAll: vi.fn(async () => {}) },
        deviceProviders: {},
    } as any;
    const instance = new ModuleInstance(
        'ain-1',
        'audio-input-302m',
        module,
        { device: MIC1, channels: 1 },
        services,
    );
    const health: string[] = [];
    instance.on('stateChange', () => {
        const s = module.getState();
        health.push(s.error ? `${s.health}: ${s.error}` : s.health);
    });
    return { module, instance, health };
}

/** The live runner reaches PLAYING; then `seconds` of meter readings, one a second (silence too). */
async function plays(seconds: number) {
    last().options.onEvent({ event: 'state_change', state: 'playing' });
    await vi.advanceTimersByTimeAsync(0);
    await meter(seconds);
}
async function meter(seconds: number) {
    for (let i = 0; i < seconds; i++) {
        last().options.onEvent({ event: 'vu_data', peak: [0, 0] });
        await vi.advanceTimersByTimeAsync(1000);
    }
}
/** Advance until a runner beyond `count` starts; the time it took (ms), or -1. */
async function rebuiltWithin(count: number, limitMs: number): Promise<number> {
    for (let t = 0; t <= limitMs; t += 100) {
        if (runners().length > count) return t;
        await vi.advanceTimersByTimeAsync(100);
    }
    return -1;
}

/** A stop under fake timers: the hosted runner hands itself back on the runner host's timers. */
async function stopped(instance: ModuleInstance) {
    const stopping = instance.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    await stopping;
}

beforeEach(() => {
    vi.useFakeTimers();
    h.FakeRunner.spawned = [];
    Object.assign(pw, { present: true, up: true, cookie: 'a1' });
    lines.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('Audio Input (302M) after a PipeWire restart (MR-021, B-195)', () => {
    it('the field case: a dead capture under a still-listed device warns, is rebuilt and plays again', async () => {
        const { instance, module, health } = await mic1();
        await instance.start();
        expect(last().startOpts!.pipeline).toContain(
            `pipewiresrc name=capture target-object=${MIC1} `,
        );
        expect(last().startOpts!.eosDrain).toBe(false);
        await plays(10);
        expect(module.getState().health).toBe('ok');

        // 05:41:30Z: PipeWire restarted in ~200 ms. The device never left the list; the stream
        // posted nothing; only the meter went quiet.
        pw.cookie = 'b2';
        const took = await rebuiltWithin(1, 10_000);
        expect(took).toBeGreaterThanOrEqual(0);
        expect(took).toBeLessThanOrEqual(6_000); // two watchdog polls and a teardown
        expect(health).toContain(`warning: ${RESTARTED}`);
        expect(runners()[0].stop).toHaveBeenCalled(); // the dead runner torn down
        // Found by the daemon's change itself, not by the stall backstop later.
        const lost = lines.filter((l) => l.msg.startsWith('PipeWire stream lost'));
        expect(lost.map((l) => l.obj.reported)).toEqual(['PipeWire restarted']);
        expect(last().startOpts!.pipeline).toContain(`target-object=${MIC1} `);
        await plays(5);
        expect(module.getState()).toMatchObject({ running: true, health: 'ok', error: null });
        expect(health.filter((h) => h.startsWith('error'))).toEqual([]);
        await stopped(instance);
    });

    it('PipeWire down a minute: one loss, no rebuild attempt and no log line while down, back within 2 s', async () => {
        const { instance, module } = await mic1();
        await instance.start();
        await plays(5);
        pw.up = false; // pactl gets no answer: the list is unknown, the cookie too
        await vi.advanceTimersByTimeAsync(PIPEWIRE_CAPTURE_STALL_MS + 2_000); // the meter stalls
        expect(runners()[0].stop).toHaveBeenCalled();
        expect(module.getState().error).toBe(
            'PipeWire is not answering — rebuilding the stream once PipeWire and the device are back',
        );
        const settled = lines.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runners()).toHaveLength(1);
        expect(lines.slice(settled)).toEqual([]);
        pw.up = true;
        pw.cookie = 'c3';
        expect(await rebuiltWithin(1, 2_000)).toBeGreaterThanOrEqual(0);
        await plays(3);
        expect(module.getState().health).toBe('ok');
        await stopped(instance);
    });

    it('three restarts in a row: each rebuilt within 10 s, the 2nd and 3rd backed off 2 and 4 s more', async () => {
        const { instance } = await mic1();
        await instance.start();
        await plays(5);
        const waits: number[] = [];
        for (const cookie of ['b2', 'c3', 'd4']) {
            pw.cookie = cookie;
            const took = await rebuiltWithin(runners().length, 10_000);
            expect(took).toBeGreaterThanOrEqual(0);
            waits.push(took);
            await plays(15);
        }
        // The 2 s wait ends on the poll that would rebuild anyway; the 4 s one shows.
        expect(waits[2]).toBeGreaterThan(waits[0]);
        expect(Math.max(...waits)).toBeLessThanOrEqual(10_000);
        const lost = lines.filter((l) => l.msg.startsWith('PipeWire stream lost'));
        expect(lost.map((l) => l.obj.rebuildInMs)).toEqual([0, 2_000, 4_000]);
        await stopped(instance);
    });

    it('a capture that stops delivering on the same daemon (unlinked) is rebuilt by the stall backstop', async () => {
        const { instance, module, health } = await mic1();
        await instance.start();
        await plays(5);
        const took = await rebuiltWithin(1, 10_000);
        expect(took).toBeGreaterThanOrEqual(0);
        expect(health.some((h) => h.startsWith('warning: No audio from the capture for '))).toBe(
            true,
        );
        await plays(3);
        expect(module.getState().health).toBe('ok');
        await stopped(instance);
    });

    it('a silent mic is never rebuilt', async () => {
        const { instance } = await mic1();
        await instance.start();
        await plays(90);
        expect(runners()).toHaveLength(1);
        await stopped(instance);
    });

    it('a failed capture element is not restarted in a loop: rebuilt once PipeWire and the device are back', async () => {
        const { instance, module } = await mic1();
        await instance.start();
        await plays(5);
        pw.present = false; // the stream errors and the node is not back yet
        last().options.onEvent({
            event: 'error',
            element: 'capture',
            message: 'stream error: no node available',
        });
        last().options.onExit(0, null);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(runners()).toHaveLength(1);
        expect(module.getState().error).toBe(
            'PipeWire stream failed (stream error: no node available) — rebuilding the stream once PipeWire and the device are back',
        );
        pw.present = true;
        expect(await rebuiltWithin(1, 2_000)).toBeGreaterThanOrEqual(0);
        await stopped(instance);
    });
});

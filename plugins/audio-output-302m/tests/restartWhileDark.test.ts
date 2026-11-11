import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-197 (MR-003, .108 1 Nov) on a real PipeWire: the engine's router, lifecycle and applier, the
 *  real Audio Mixer and Audio Output (302M) on the native runner, tones as 302M sources, what
 *  reaches the virtual sink recorded off its monitor. Two mic tones mix on the left channel (the
 *  Audio Mixer), the SRT leg's tone (a relay in the Audio Transcoder's shape) on the right.
 *  Skipped, saying why, without PipeWire, an element, the plugin or the runner. */

// The engine's own copy: this plugin does not depend on shared-types.
import { setLogTap } from '../../../packages/shared-types/src/index.js';
import {
    MonitorRecorder,
    PrivatePipeWire,
    linkPlaybackStreams,
    pulsesinkUnmatched,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { engine as rigEngine, type Rig } from './mixRig.js';

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
/** A late leg's join slews the mix (B-80) and underruns the output once: only a pulsesink of the
 *  core's version plays on after that (B-167), so that drill runs on such an install alone. */
const unmatched = skip === null ? pulsesinkUnmatched(registry) : null;

/** The Pi 4 test box's rig on this test's sink (`mixRig.ts`). */
const engine = (rig: Omit<Rig, 'sink'> = {}) => rigEngine({ sink: SINK, ...rig });

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
            if (unmatched) console.warn(`[B-167] late-leg drill skipped — ${unmatched}`);
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

        it("the Pi 4 test box's drill: restarted while the SRT leg is dark and down, re-linked with its last transient: the mics play within 2 s and on, the leg joins within 2 s of delivering, no relaunch", async () => {
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
            expect(await soundsWithin(L, 2000)).toBe(true);
            const from = rec.at();
            console.log(
                `[B-197] mics back ${Math.round((from - restarted) * 1000)} ms after the restart`,
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
            const lit = rec.at();
            await e.srtin().setDark(false);
            expect(await soundsWithin(R, 2000)).toBe(true);
            const heard = rec.at();
            await sleep(2000);
            // B-167: no silence over 40 ms on the mics from when they played, the leg's join included.
            const gap = rec.longestGapMs(L, from, rec.at());
            console.log(
                `[B-167] the leg plays ${Math.round((heard - lit) * 1000)} ms after it delivers; mics' longest silence ${gap} ms`,
            );
            expect(gap).toBeLessThanOrEqual(40);
            expect(e.outLaunch()).toBe(launch);
        });

        it.skipIf(unmatched !== null)(
            'a restart with a leg 500 ms late: the late leg joins and both play',
            async () => {
                // The SRT leg is 500 ms late. The mics' channels come late, so the leg's edge is the
                // output's first; the restart re-applies the Mixer's first.
                const e = await start({ relay: { delayMs: 500 }, micsLateMs: 2500 });
                expect(await soundsWithin(L, 25_000)).toBe(true);
                expect(await soundsWithin(R, 10_000)).toBe(true);
                await e.srtin().setDark(true);
                await sleep(1000);
                await e.lifecycle.restart('out');
                expect(await soundsWithin(L, 4000)).toBe(true);
                await e.srtin().setDark(false);
                expect(await soundsWithin(R, 6000)).toBe(true);
                expect(sounds(L, 1000)).toBe(true);
            },
        );

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

        it('an output whose mix arrives 500 ms late plays it as it comes (B-167: no playout offset): no warning', async () => {
            // The sink waits for no stamp and nothing reads lateness at it, so the mix plays on arrival.
            const e = await start({ relay: { delayMs: 500 } });
            expect(await soundsWithin(L, 12_000)).toBe(true);
            expect(await soundsWithin(R, 6000)).toBe(true);
            await sleep(3000);
            expect(sounds(L, 2000)).toBe(true);
            expect(e.out().getState().error ?? '').not.toMatch(/^Plays nothing/);
        });
    },
);

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** B-206 (MR-029, .108 3 Nov) on a real PipeWire, the .108 rig of `mixRig.ts`. PipeWire restarts
 *  and takes the mic captures with it, so the Audio Mixer runs with no input and then sends the
 *  seconds it missed at once, stamped in the past, its hole as GAPs. An output whose rebuild meets
 *  that burst used to take it as its first data: its aligner's queue filled, the pace latched the
 *  held arrivals for minutes, every buffer missed the sink, and the route was raised for good.
 *  Skipped, saying why, without PipeWire, an element, the plugin or the runner. */

import { setLogTap } from '../../../packages/shared-types/src/index.js';
import {
    MonitorRecorder,
    PrivatePipeWire,
    linkPlaybackStreams,
    realPipeWireSkip,
    sleep,
    until,
} from '../../../packages/engine/src/audio/testing/privatePipeWire.js';
import { engine } from './mixRig.js';

const SINK = 'c29_spk';
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
    'unixfdsrc',
    'unixfdsink',
];
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b206-registry-${process.pid}.bin`);
const skip = existsSync(TIMING_PLUGIN)
    ? realPipeWireSkip(ELEMENTS, registry)
    : 'the timing plugin is not built (libgstmrtshouse.so)';

beforeAll(() => {
    if (skip) console.warn(`[B-206] real PipeWire restart test (302M mix) skipped — ${skip}`);
});

describe.skipIf(skip !== null)(
    "Audio Output (302M) rebuilt into a source's outage burst (B-206)",
    { timeout: 240_000 },
    () => {
        let pw: PrivatePipeWire;
        let rec: MonitorRecorder;
        let stopLinking: () => Promise<void>;
        let stopRig: (() => Promise<void>) | null = null;
        let savedBusDir: string | undefined;
        let recordings = 0;
        const lines: Array<{ name: string; msg: string; level: number }> = [];

        /** `ch` sounds over the last `ms` (90 % of its 10 ms windows). */
        const sounds = (ch: 0 | 1, ms = 500) =>
            rec.presence(ch, rec.at() - ms / 1000, rec.at()) > 0.9;
        const soundsWithin = (ch: 0 | 1, budgetMs: number) => until(() => sounds(ch), budgetMs);
        const said = (msg: RegExp) => lines.some((l) => l.name === 'Plugin:out' && msg.test(l.msg));
        /** The monitor recorder dies with PipeWire: a new one on the PipeWire that runs now. */
        const record = async () => {
            rec = await MonitorRecorder.start(pw, SINK, join(pw.root, `monitor-${++recordings}.raw`));
        };

        beforeAll(async () => {
            pw = new PrivatePipeWire({ sinks: [SINK] });
            pw.enter(registry);
            savedBusDir = process.env.MR_BUS_SOCKET_DIR;
            process.env.MR_BUS_SOCKET_DIR = join(pw.root, 'bus');
            mkdirSync(process.env.MR_BUS_SOCKET_DIR, { recursive: true });
            setLogTap((l: string) => lines.push(JSON.parse(l)));
            await pw.start();
            stopLinking = linkPlaybackStreams(pw, SINK);
            await record();
        }, 120_000);

        afterEach(async () => {
            await stopRig?.();
            stopRig = null;
            lines.length = 0;
        }, 60_000);

        afterAll(async () => {
            await rec?.stop().catch(() => {});
            await stopLinking?.();
            await pw?.stop();
            pw?.remove();
            setLogTap(null);
            pw?.leave();
            if (savedBusDir === undefined) delete process.env.MR_BUS_SOCKET_DIR;
            else process.env.MR_BUS_SOCKET_DIR = savedBusDir;
            if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b206-registry-')) {
                rmSync(registry, { force: true });
            }
        }, 60_000);

        async function started() {
            const e = engine({ sink: SINK });
            stopRig = () => e.lifecycle.stopAll();
            await e.lifecycle.startAll();
            expect(await soundsWithin(L, 25_000)).toBe(true);
            expect(await soundsWithin(R, 10_000)).toBe(true);
            await sleep(3000);
            lines.length = 0;
            return e;
        }

        /** 18 s from now, past the re-anchor's 15 s hold: the route never raised, never 'Plays
         *  nothing', and neither channel silent for a second (a loaded Pi drops a few blocks). */
        async function expectPlaysOn(e: ReturnType<typeof engine>) {
            const from = rec.at();
            await sleep(18_000);
            expect(e.router.getRoutePlayoutRaiseMs('out')).toBe(0);
            expect(said(/^Plays nothing/)).toBe(false);
            const gaps = [rec.longestGapMs(L, from, rec.at()), rec.longestGapMs(R, from, rec.at())];
            console.log(`[B-206] longest silences after it played: L ${gaps[0]} ms, R ${gaps[1]} ms`);
            expect(Math.max(...gaps)).toBeLessThan(1000);
        }

        /** PipeWire down `ms` with the mics' captures (their runners stop with it). */
        async function pipeWireDown(e: ReturnType<typeof engine>, ms: number) {
            await rec.stop().catch(() => {});
            await pw.stop();
            await Promise.all([e.mic('micA').down(), e.mic('micB').down()]);
            await sleep(ms);
        }

        it('the mics back as it rebuilds: plays at its own D within 2 s, never raised, the burst skipped in one line', async () => {
            const e = await started();
            await pipeWireDown(e, 6000);
            await pw.start();
            await record();
            expect(await until(() => said(/^PipeWire stream rebuilt$/), 15_000)).toBe(true);
            // The Mixer's burst (about 7 s of the past) is the rebuilt output's first data.
            await Promise.all([e.mic('micA').up(), e.mic('micB').up()]);
            const rebuilt = Date.now();
            expect(await soundsWithin(L, 2500)).toBe(true);
            expect(await soundsWithin(R, 1000)).toBe(true);
            console.log(`[B-206] the mix plays ${Date.now() - rebuilt} ms after the rebuild`);
            // Past the re-anchor's 15 s hold: never raised, never 'Plays nothing', no silence.
            await expectPlaysOn(e);
            expect(e.out().getState().health).toBe('ok');
            const caught = lines.filter((l) => /^Caught up at the start: skipped/.test(l.msg));
            expect(caught).toHaveLength(1);
            expect(caught[0].msg).toMatch(/skipped \d+\.\d s of Mixer/);
        });

        it('rebuilt seconds after the burst (the Mixer\'s egress still reads it): its seed holds to the ts-offset, it plays at its own D', async () => {
            const e = await started();
            await pipeWireDown(e, 6000);
            // The Mixer sends its burst while the output is down: its egress window reads seconds.
            await Promise.all([e.mic('micA').up(), e.mic('micB').up()]);
            await sleep(1000);
            await pw.start();
            await record();
            expect(await until(() => said(/^PipeWire stream rebuilt$/), 15_000)).toBe(true);
            expect(await soundsWithin(L, 2500)).toBe(true);
            await expectPlaysOn(e);
        });

        it('the mics back 5 s after it rebuilt: the burst and the stale GAPs over its hole skipped, it plays at its own D', async () => {
            const e = await started();
            await pipeWireDown(e, 6000);
            await pw.start();
            await record();
            expect(await until(() => said(/^PipeWire stream rebuilt$/), 15_000)).toBe(true);
            const rebuilt = Date.now();
            // The Mixer sends nothing until its mics are back: the SRT leg plays once it is gapped.
            expect(await soundsWithin(R, 4000)).toBe(true);
            console.log(`[B-206] the SRT leg plays ${Date.now() - rebuilt} ms after the rebuild`);
            await sleep(Math.max(0, 5000 - (Date.now() - rebuilt)));
            await Promise.all([e.mic('micA').up(), e.mic('micB').up()]);
            const up = Date.now();
            expect(await soundsWithin(L, 2500)).toBe(true);
            expect(await soundsWithin(R, 1000)).toBe(true);
            console.log(`[B-206] the mix plays ${Date.now() - up} ms after the mics are back`);
            await expectPlaysOn(e);
            expect(e.out().getState().health).toBe('ok');
            expect(lines.some((l) => /^Caught up at the start: skipped .* of Mixer/.test(l.msg))).toBe(true);
        });
    },
);

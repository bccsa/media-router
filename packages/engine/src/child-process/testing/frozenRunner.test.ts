import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstPluginBase } from '../../plugins/GstPluginBase.js';
import type { ModuleServices, PipelineDescription } from '../../plugins/PluginModule.js';
import { NATIVE_RUNNER, sleep, until } from '../../audio/testing/privatePipeWire.js';

/** B-246 (F-6, G2-1) on both real runners: a runner frozen by SIGSTOP for 12 s shows the module
 *  warning within the watch's bound and loses it within 5 s of SIGCONT; none before the freeze. */

const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../../../../../plugins');
const TIMING_PLUGIN = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');
/** Never the user's registry: the gate's own, or one of this run's. */
const registry = process.env.GST_REGISTRY ?? join(tmpdir(), `mr-b246-registry-${process.pid}.bin`);
const ELEMENTS = ['audiotestsrc', 'audioconvert', 'fakesink'];

function skipReason(): string | null {
    if (!existsSync(NATIVE_RUNNER)) return 'mr-gst-runner not built (make native)';
    if (!existsSync(TIMING_PLUGIN)) return 'the timing plugin is not built (libgstmrtshouse.so)';
    if (spawnSync('python3', ['-c', 'import gi'], { stdio: 'ignore' }).status !== 0)
        return 'python3 gi unavailable';
    const env = { ...process.env, GST_REGISTRY: registry };
    const absent = ELEMENTS.filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
}
const skip = skipReason();

const NOT_ANSWERING = /^Pipeline not answering for \d+ s \(stalled or frozen\)$/;
/** The watch's bound: 5 s to the next ask, two 3 s misses (runnerLiveness.ts), and slack. */
const WARN_WITHIN_MS = 11_500;

class Tone extends GstPluginBase {
    constructor(private readonly runner: 'native' | 'python') {
        super();
    }
    buildPipeline(): PipelineDescription {
        return {
            pipeline:
                'audiotestsrc is-live=true wave=sine ! audioconvert ! fakesink name=sink sync=true',
            runner: this.runner,
        };
    }
}

describe.skipIf(skip !== null)('a frozen runner (B-246)', { timeout: 120_000 }, () => {
    const saved = process.env.GST_REGISTRY;
    beforeAll(() => {
        process.env.GST_REGISTRY = registry;
    });
    afterAll(() => {
        if (saved === undefined) delete process.env.GST_REGISTRY;
        else process.env.GST_REGISTRY = saved;
        if (!process.env.GST_REGISTRY_KEEP && registry.includes('mr-b246-registry-'))
            rmSync(registry, { force: true });
    });

    it.each(['native', 'python'] as const)(
        '%s: SIGSTOP 12 s warns within the bound, SIGCONT clears within 5 s',
        async (runner) => {
            const m = new Tone(runner);
            await m.onInit({}, { instanceId: `b246-${runner}` } as unknown as ModuleServices);
            let pid: number | undefined;
            let stopped = false;
            try {
                await m.onStart();
                expect(await until(() => m.getChildProcess()?.isRunning === true, 20_000)).toBe(
                    true,
                );
                const healthy = m.getState().error;
                // No false alarm while it plays: past two whole ask periods.
                const steady = Date.now();
                let alarm = false;
                while (Date.now() - steady < 11_000) {
                    alarm ||= NOT_ANSWERING.test(m.getState().error ?? '');
                    await sleep(100);
                }
                expect(alarm).toBe(false);

                pid = m.getChildProcess()?.pid;
                expect(pid).toBeGreaterThan(0);
                process.kill(pid!, 'SIGSTOP');
                stopped = true;
                const frozenAt = Date.now();
                const warned = await until(
                    () => NOT_ANSWERING.test(m.getState().error ?? ''),
                    WARN_WITHIN_MS,
                );
                const warnedAfter = Date.now() - frozenAt;
                expect(warned, `warning ${warnedAfter} ms after SIGSTOP`).toBe(true);
                expect(m.getState().health).toBe('warning');
                await sleep(Math.max(0, 12_000 - (Date.now() - frozenAt)));

                process.kill(pid!, 'SIGCONT');
                stopped = false;
                const resumedAt = Date.now();
                const cleared = await until(
                    () => !NOT_ANSWERING.test(m.getState().error ?? ''),
                    5000,
                );
                const clearedAfter = Date.now() - resumedAt;
                expect(cleared, `cleared ${clearedAfter} ms after SIGCONT`).toBe(true);
                console.log(
                    `B-246 ${runner}: warned ${warnedAfter} ms after SIGSTOP, cleared ${clearedAfter} ms after SIGCONT`,
                );
                // Back to what it was before the freeze (ok, or the rule-6 alarm if it stood).
                expect(m.getState().error ?? null).toBe(healthy ?? null);
                expect(m.getChildProcess()?.pid).toBe(pid);
            } finally {
                if (stopped && pid) process.kill(pid, 'SIGCONT');
                await m.onDestroy();
            }
        },
    );
});

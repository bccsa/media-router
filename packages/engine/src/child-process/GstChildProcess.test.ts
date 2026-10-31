import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GstChildProcess, throwIfRpcError } from './GstChildProcess.js';
import { ForkedRunnerBackend } from './ForkedRunnerBackend.js';
import { holdUntilZombie, uncaughtDuring } from './testing/unreapedChild.js';

describe('throwIfRpcError', () => {
    it('throws an Error with the Python message when the result carries an error', () => {
        expect(() =>
            throwIfRpcError({ error: 'Element not found: nov' }, 'setProperty(nov.text)'),
        ).toThrowError('setProperty(nov.text): Element not found: nov');
    });

    it('does not throw for a successful response payload', () => {
        expect(() =>
            throwIfRpcError(
                { event: 'property_set', element: 'vol', property: 'volume', value: 0.5 },
                'setProperty(vol.volume)',
            ),
        ).not.toThrow();
    });

    it('does not throw for null or undefined results', () => {
        expect(() => throwIfRpcError(null, 'op')).not.toThrow();
        expect(() => throwIfRpcError(undefined, 'op')).not.toThrow();
    });

    it('ignores a non-string error field', () => {
        // Defensive: a stray `error: true` from a non-command_error payload
        // shouldn't be treated as an RPC failure.
        expect(() => throwIfRpcError({ error: true }, 'op')).not.toThrow();
    });
});

describe('sticky property replay', () => {
    // Drives the record/replay contract without forking a child: inject a
    // fake ControlIpc and flip `running` the way the stateChange handler does.
    function harness() {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const sendRequest = vi.fn(async () => ({}));
        child.ipc = { sendRequest, destroy: vi.fn() };
        child.running = true;
        return { child, sendRequest };
    }

    it('records the last value per element property and replays all of them', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('vol', 'volume', 0.5);
        await child.setProperty('vol', 'volume', 0.25); // supersedes 0.5
        await child.setProperty('nov', 'text', 'Cam 1');
        sendRequest.mockClear();

        await child.replayStickyProps();
        expect(sendRequest).toHaveBeenCalledTimes(2); // one per property, latest value
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'vol', property: 'volume', value: 0.25 },
            2000,
        );
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'nov', property: 'text', value: 'Cam 1' },
            2000,
        );
    });

    it('records intent while the pipeline is down and applies it on replay', async () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        // No ipc, not running — the set can't be delivered, but must be kept.
        await child.setProperty('vol', 'volume', 0.7);

        const sendRequest = vi.fn(async () => ({}));
        child.ipc = { sendRequest };
        child.running = true;
        await child.replayStickyProps();
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            { element: 'vol', property: 'volume', value: 0.7 },
            2000,
        );
    });

    it('a failed replay of one property does not block the others', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('gone', 'volume', 0.5);
        await child.setProperty('vol', 'volume', 0.25);
        sendRequest.mockImplementation(async (_a: string, d: { element: string }) =>
            d.element === 'gone' ? { error: 'Element not found: gone' } : {},
        );
        await child.replayStickyProps(); // must not throw
        expect(sendRequest).toHaveBeenCalledWith(
            'setProperty',
            expect.objectContaining({ element: 'vol' }),
            2000,
        );
    });

    it('keys on element + NUL + property, so no element/property pair can collide', async () => {
        // The separator must be a character neither half can contain. Pinned
        // because the source used to carry a LITERAL NUL (invisible in editors
        // and diffs); the escape rewrite has to keep the exact same runtime key
        // or a live pipeline's recorded properties silently split in two.
        const { child } = harness();
        await child.setProperty('vol', 'volume', 0.5);
        expect([...child.stickyProps.keys()]).toEqual(['vol\u0000volume']);

        // `a\0b` vs `ab\0`: same concatenation, different pair — two entries.
        await child.setProperty('a', 'b', 1);
        await child.setProperty('ab', '', 2);
        expect(child.stickyProps.size).toBe(3);
    });

    it('stop() clears the recorded properties', async () => {
        const { child, sendRequest } = harness();
        await child.setProperty('vol', 'volume', 0.5);
        await child.stop();
        child.ipc = { sendRequest, destroy: vi.fn() };
        child.running = true;
        sendRequest.mockClear();
        await child.replayStickyProps();
        expect(sendRequest).not.toHaveBeenCalled();
    });
});

describe('start payload', () => {
    // The payload enumerates description fields EXPLICITLY, so a field dropped
    // here is lost silently (the decoderThreadType trap). `env` is load-bearing
    // twice over: the wayland surface app_id that pins the picture to an output,
    // and the video player's GST_PLUGIN_FEATURE_RANK mask that stops decodebin3
    // auto-plugging a decoder demoted at runtime.
    const payloadFor = (desc: Record<string, unknown>) =>
        (new GstChildProcess('/nonexistent/gst-runner.js') as any).startPayload(desc);

    it('carries the pipeline env verbatim', () => {
        const env = {
            MR_GLIB_PRGNAME: 'local.mr.HDMI-A-1',
            GST_PLUGIN_FEATURE_RANK: 'v4l2slh265dec:NONE',
        };
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink', env }).env).toEqual(env);
    });

    it('defaults env to an empty object rather than dropping the key', () => {
        // PythonProcess destructures `env` off the start opts and merges it over
        // process.env at spawn — undefined would be fine, absent must stay safe.
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).env).toEqual({});
    });

    it('forwards keyframeGate — dropping it re-arms a kernel-level V4L2 hang', () => {
        // The gate is what stops a stateless V4L2 decoder being handed delta
        // units on a mid-GOP live join; losing it here would leave the pipeline
        // string looking correct while the decoder runs ungated.
        const keyframeGate = { decoder: 'vpdec' };
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink', keyframeGate }).keyframeGate).toEqual(
            keyframeGate,
        );
        // Absent on the decodebin3 rung / fallback card — must stay absent, not
        // become a gate on an element that doesn't exist (a hard start error).
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).keyframeGate).toBeUndefined();
    });

    it('forwards backlogShed — dropping it leaves every paced leg on the ratchet', () => {
        // The guard against the contract's latency ratchet. Lost here, the
        // pipeline string still looks correct and the leg still plays — it just
        // decays over HOURS while reporting itself healthy, which is exactly the
        // failure it was written for (.42, 2026-08-13/14).
        const backlogShed = {
            element: 'vpdec',
            sink: 'sink',
            keyframeAligned: true,
            toleranceMs: 250,
            holdMs: 5_000,
            cooldownMs: 60_000,
            sanityMs: 10_000,
        };
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink', backlogShed }).backlogShed).toEqual(
            backlogShed,
        );
        // Absent on an unpaced leg — must stay absent, not become a shedder on
        // elements that may not exist (a hard start error).
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).backlogShed).toBeUndefined();
    });

    it('forwards liveCaptureClock — dropping it puts a live capture head back on the pinned timeline', () => {
        // The flag selects the contract variant that keeps the house clock but
        // lets base-time anchor naturally. Lost here, video-encoder's
        // `v4l2src ! … ! mpegtsmux` goes back to running-time ≡ house time and
        // the aggregator mux releases video in GOP-sized ~2.3 s bursts (Pi4 +
        // ATEM): the pipeline string is unchanged and nothing reports it.
        expect(
            payloadFor({ pipeline: 'fakesrc ! fakesink', liveCaptureClock: true }).liveCaptureClock,
        ).toBe(true);
        // Omitted → false, not undefined: every bus-fed producer keeps the
        // pinned timeline its demux's PES − 1 h is house time on.
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).liveCaptureClock).toBe(false);
    });
});

describe('start payload (the wire to the runner)', () => {
    // `startPayload` is an explicit field list, so a description field the
    // runner reads only exists on the wire if it is named here — a stamper
    // flag was dropped exactly this way once (review, 2026-09-06).
    it('carries exactly the runner-relevant fields, no stamper policy among them', () => {
        // The egress stamp needs no field: every egress is stamped by identity (WI-P2-3).
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        expect(Object.keys(child.startPayload({ pipeline: 'x' })).sort()).toEqual([
            'backlogShed',
            'busReports',
            'decoderThreadType',
            'env',
            'eosDrain',
            'keyframeGate',
            'linkOnPadAdded',
            'liveCaptureClock',
            'liveInputBranches',
            'pipeline',
            'readKlvNames',
            'renderWatch',
            'restartBackoffMs',
            'restartOnError',
            'rist',
            'runner',
            'runnerHooks',
            'tsProbe',
            'udpSilenceRestartMs',
            'useStdioForData',
        ]);
    });

    it('carries udpSilenceRestartMs (multicast re-join bound), and omits it when unset', () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        expect(
            child.startPayload({ pipeline: 'x', udpSilenceRestartMs: 60000 }).udpSilenceRestartMs,
        ).toBe(60000);
        expect(child.startPayload({ pipeline: 'x' }).udpSilenceRestartMs).toBeUndefined();
    });

    it('records the pipeline launch instant and clears it when the pipeline stops or errors', () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const handlers = new Map<string, (d: unknown) => void>();
        child.wireRunnerEvents({ on: (n: string, h: (d: unknown) => void) => handlers.set(n, h) });
        const fire = (name: string, data: unknown) => handlers.get(name)?.(data);

        expect(child.pipelineLaunchedAt).toBeUndefined();
        fire('pipelineLaunched', { at: 1000 });
        expect(child.pipelineLaunchedAt).toBe(1000);
        fire('stateChange', { state: 'stopped' });
        expect(child.pipelineLaunchedAt).toBeUndefined();
        fire('pipelineLaunched', { at: 2000 });
        fire('stateChange', { state: 'error' });
        expect(child.pipelineLaunchedAt).toBeUndefined();
        // A runner-internal relaunch retires the old python silently (no
        // stopped event) — `pipelineStarting` must clear it instead.
        fire('pipelineLaunched', { at: 3000 });
        fire('pipelineStarting', {});
        expect(child.pipelineLaunchedAt).toBeUndefined();
    });

    it('passes the timing plugin outcome through to the module (plan ch. 3 WI-S0-8)', () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const handlers = new Map<string, (d: unknown) => void>();
        child.wireRunnerEvents({ on: (n: string, h: (d: unknown) => void) => handlers.set(n, h) });
        const seen: unknown[] = [];
        child.on('timingPlugin', (d: unknown) => seen.push(d));
        handlers.get('timingPlugin')?.({ detail: 'libgstmrtshouse.so abi 0 < 1: /x' });
        expect(seen).toEqual([{ detail: 'libgstmrtshouse.so abi 0 < 1: /x' }]);
    });

    it('restartPipeline clears the launch instant at once, so a second producer PLAYING cannot relaunch mid-gate', async () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        child.ipc = { sendRequest: vi.fn(async () => ({ ok: true })) };
        child.pipelineDesc = { pipeline: 'fakesrc ! fakesink' };
        child.launchedAt = 1000;
        await child.restartPipeline('t');
        expect(child.pipelineLaunchedAt).toBeUndefined();
    });

    it('restartPipeline asks the runner to relaunch; a no-op with no pipeline; surfaces runner errors', async () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const sendRequest = vi.fn(async () => ({ ok: true }));
        child.ipc = { sendRequest };
        await child.restartPipeline('x'); // no pipelineDesc yet
        expect(sendRequest).not.toHaveBeenCalled();

        child.pipelineDesc = { pipeline: 'fakesrc ! fakesink' };
        await child.restartPipeline('producer p relaunched');
        expect(sendRequest).toHaveBeenCalledWith(
            'restartPipeline',
            { reason: 'producer p relaunched' },
            5000,
        );

        sendRequest.mockResolvedValueOnce({ error: 'No pipeline to restart' });
        await expect(child.restartPipeline('again')).rejects.toThrow('No pipeline to restart');
    });

    it('carries runnerHooks verbatim — plugin python the runner must install', () => {
        const child = new GstChildProcess('/nonexistent/gst-runner.js') as any;
        const hooks = [
            {
                module: 'subtitle_bridge',
                config: { pay: [{ appsink: 'a', appsrc: 'b', holdMs: 8000 }] },
            },
        ];
        expect(child.startPayload({ pipeline: 'x', runnerHooks: hooks }).runnerHooks).toEqual(
            hooks,
        );
        expect(child.startPayload({ pipeline: 'x' })).toHaveProperty('runnerHooks', undefined);
    });
});

describe('fork backend (MR_GST_RUNNER_FORK=1)', () => {
    let dir: string;
    let shim: string;

    beforeAll(() => {
        // Stands in for gst-runner.js: answers every request and stays up on its IPC channel.
        dir = mkdtempSync(join(tmpdir(), 'mr-fork-shim-'));
        shim = join(dir, 'shim.cjs');
        writeFileSync(
            shim,
            "process.on('message', (m) => m.type === 'request' &&\n" +
                "    process.send({ id: m.id, type: 'response', action: '', data: {} }));\n",
        );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('a send into a shim that died before it is reaped is heard, not fatal (B-87)', async () => {
        const backend = new ForkedRunnerBackend(shim);
        const emit = vi.spyOn(backend['child'], 'emit');
        const exited = new Promise<number | null>((resolve) => backend.onExit(resolve));
        try {
            await backend.channel.sendRequest('startPipeline', {}, 10_000);
            const unheard = await uncaughtDuring(async () => {
                process.kill(backend.pid!, 'SIGKILL');
                holdUntilZombie(backend.pid!);
                // What GstChildProcess.sendBusDetach sends while the exit is not yet processed.
                backend.channel.sendEvent('busDetach', { socket: '/tmp/mr-bus-edge.sock' });
                expect(await exited).toBeNull();
            });
            expect(unheard).toEqual([]);
            expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'EPIPE' }));
        } finally {
            backend.destroy();
        }
    }, 15_000);
});

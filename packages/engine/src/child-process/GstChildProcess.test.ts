import { describe, it, expect, vi } from 'vitest';
import { GstChildProcess, throwIfRpcError } from './GstChildProcess.js';

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
        // Absent on the legacy path — must stay absent, not become a shedder on
        // elements that may not exist (a hard start error).
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).backlogShed).toBeUndefined();
    });

    it('forwards timeSyncContract — dropping it silently reverts to the net clock', () => {
        // The flag is the ONLY thing telling the runner to pin the timeline
        // (monotonic clock, base_time 0). Lost here, the pipeline would run on
        // its auto-selected clock with a per-start base-time, which is exactly
        // the drift the contract exists to remove — and nothing would report it.
        expect(
            payloadFor({ pipeline: 'fakesrc ! fakesink', timeSyncContract: true })
                .timeSyncContract,
        ).toBe(true);
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).timeSyncContract).toBe(false);
    });

    it('forwards alignBranchesToStamps — dropping it puts the mux back on luck', () => {
        // Caught HERE the hard way (.202, 2026-08-14): the mux built the config,
        // the runner knew what to do with it, and the field skew was untouched
        // because the payload never carried it — the decoderThreadType trap
        // again, and invisible from either end. Without it each mux input branch
        // keeps the private zero point it took off the one bus buffer its
        // tsdemux locked on, i.e. the 100–121 ms A/V skew, re-drawn per restart.
        const alignBranchesToStamps = { demuxes: ['demux_0', 'demux_1'] };
        expect(
            payloadFor({ pipeline: 'fakesrc ! fakesink', alignBranchesToStamps })
                .alignBranchesToStamps,
        ).toEqual(alignBranchesToStamps);
        // Absent on the legacy path (applyTimeSync drops it there) — must stay
        // absent rather than arming probes on elements that may not exist.
        expect(payloadFor({ pipeline: 'fakesrc ! fakesink' }).alignBranchesToStamps).toBeUndefined();
    });
});

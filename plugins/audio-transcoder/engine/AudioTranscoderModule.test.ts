import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GstPluginBase } from '@media-router/engine';
import { AudioTranscoderModule } from './AudioTranscoderModule.js';
import { INPUT_PORT_ID } from './audioTranscoderPorts.js';
import { REPROBE_INTERVAL_MS } from './reprobeLoop.js';

interface SourceOpts {
    streamType?: string;
    channelMap?: Array<{ srcChannel: number; dstChannel: number; gain?: number }>;
}

/**
 * Test double for the codec probe — scripted codecs instead of spawning
 * gst-launch against a bus socket. Successive probes shift the list; the last
 * value repeats (matches the `resolveLadspa` override seam in audio-processing).
 */
class TestTranscoder extends AudioTranscoderModule {
    /** Codecs returned by successive probes; the last entry repeats. */
    public codecs: string[] = ['unknown'];
    public probeCalls = 0;

    protected async probeStream(): Promise<{ codec: string; rawCaps: string }> {
        this.probeCalls++;
        const codec = this.codecs.length > 1 ? this.codecs.shift()! : this.codecs[0];
        return { codec, rawCaps: '' };
    }
}

/** Harness with an optional single source wired to the input port. */
function makeModule(
    source?: SourceOpts,
    opts: { busPort?: number | null; instance?: AudioTranscoderModule } = {},
) {
    const module = (opts.instance ?? new AudioTranscoderModule()) as any;
    let nextPort = 41000;
    const busSources = source
        ? [
              {
                  port: 40100,
                  socketPath: '/tmp/mr-bus-40100-x.sock',
                  connectionId: 'c-0',
                  sourceModuleId: 'src-0',
                  sourcePortId: 'out-0',
                  sinkPortId: INPUT_PORT_ID,
                  streamType: source.streamType ?? 'muxed/mpegts',
                  channelMap: source.channelMap,
              },
          ]
        : [];
    module.services = {
        instanceId: 'atx-1',
        mediaRouter: {
            getModuleBusSources: vi.fn(() => busSources),
            assignBusChannel: vi.fn(() => (opts.busPort === null ? null : { port: nextPort++ })),
        },
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

beforeEach(() => {
    vi.clearAllMocks();
    AudioTranscoderModule.setS302mSupported(true);
});

describe('AudioTranscoderModule.getDynamicPorts', () => {
    it('exposes one single-source input + per-rendition outputs from config', () => {
        const { module } = makeModule();
        module.config = {
            renditions: [{ codec: 'opus' }, { codec: 'pcm' }],
        };
        const ports = module.getDynamicPorts();
        const inputs = ports.filter((p: any) => p.direction === 'input');
        expect(inputs).toHaveLength(1);
        expect(inputs[0].maxConnections).toBe(1);
        expect(ports.filter((p: any) => p.direction === 'output')).toHaveLength(2);
    });
});

describe('AudioTranscoderModule.buildPipeline', () => {
    it('returns null + warning when nothing is wired', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No input'));
    });

    it('returns null + warning on zero renditions', () => {
        const { module, setHealth } = makeModule({});
        expect(module.buildPipeline({ renditions: [] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No renditions'));
    });

    it('decode-once front-end, probed codec picks the chain (no mixer element)', () => {
        const { module } = makeModule({});
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('tsdemux name=demux latency=0');
        expect(desc!.pipeline).toContain('aacparse ! avdec_aac');
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.restartOnError).toBe(true);
    });

    it('carries preserveSourceTimeline targeting the named demux by default', () => {
        const { module } = makeModule({});
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.preserveSourceTimeline).toEqual({ demux: 'demux' });
        // A producer never asks for branch alignment: its egress stamper has
        // anchored by the time the correction would land (see buildPipeline).
        expect(desc!.alignBranchesToStamps).toBeUndefined();
    });

    it('preserveSourceTimeline: false disables the runner feature (rollback knob)', () => {
        const { module } = makeModule({});
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({
            renditions: [{ codec: 'opus' }],
            preserveSourceTimeline: false,
        });
        expect(desc!.preserveSourceTimeline).toBeUndefined();
    });

    it('a 302M-declared source decodes the same way (probe → avdec_s302m)', () => {
        const { module } = makeModule({ streamType: 'audio/302m' });
        module.probeResult = { codec: 's302m' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.pipeline).toContain('avdec_s302m');
        expect(desc!.pipeline).not.toContain('audiomixer');
    });

    it('a connection channel map is inlined as a trunk mix-matrix', () => {
        const { module } = makeModule({
            streamType: 'audio/302m',
            channelMap: [
                { srcChannel: 0, dstChannel: 0, gain: 0.5 },
                { srcChannel: 1, dstChannel: 0, gain: 0.5 },
            ],
        });
        module.probeResult = { codec: 's302m' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.pipeline).toContain(
            'mix-matrix="<<(float)0.5000, (float)0.5000>, <(float)0.0000, (float)0.0000>>"',
        );
        // Matrix rows must match the negotiated channel count → pinned caps.
        expect(desc!.pipeline).toContain('audio/x-raw,channels=2');
    });

    it('matrix input dimension comes from the probe, not a stereo pin (5.1 source)', () => {
        const { module } = makeModule({
            channelMap: [
                { srcChannel: 0, dstChannel: 0 },
                { srcChannel: 2, dstChannel: 1 },
            ],
        });
        module.probeResult = { codec: 'ac3', channels: 6 };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        // 2 rows (output stereo) × 6 columns (probed source channels).
        expect(desc!.pipeline).toContain(
            'mix-matrix="<<(float)1.0000, (float)0.0000, (float)0.0000, (float)0.0000, (float)0.0000, (float)0.0000>, <(float)0.0000, (float)0.0000, (float)1.0000, (float)0.0000, (float)0.0000, (float)0.0000>>"',
        );
    });

    it('unknown probe codec builds decodebin but surfaces a health WARNING, not ok', () => {
        const { module, setHealth } = makeModule({});
        module.probeResult = { codec: 'unknown' };
        const desc = module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('decodebin');
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('codec unknown'));
        // The warning names the self-heal, not a manual restart.
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('re-probing'));
        expect(setHealth).not.toHaveBeenCalledWith('ok');
    });

    it('health error when a pcm rendition is configured on a runtime without 302M TS support', () => {
        AudioTranscoderModule.setS302mSupported(false);
        const { module, setHealth } = makeModule({});
        expect(module.buildPipeline({ renditions: [{ codec: 'pcm' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('1.26'));
    });

    it('allocates a distinct bus channel per rendition', () => {
        const { module } = makeModule({});
        const desc = module.buildPipeline({
            renditions: [{ codec: 'opus' }, { codec: 'aac' }],
        });
        expect(desc).not.toBeNull();
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-0');
        expect(module.services.mediaRouter.assignBusChannel).toHaveBeenCalledWith('atx-1', 'out-1');
    });

    it('health error when the bus channel pool is exhausted', () => {
        const { module, setHealth } = makeModule({}, { busPort: null });
        expect(module.buildPipeline({ renditions: [{ codec: 'opus' }] })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('exhausted'));
    });

    it('never contains PipeWire capture/re-stamp elements', () => {
        const { module } = makeModule({});
        const desc = module.buildPipeline({ renditions: [{ codec: 'pcm' }] });
        expect(desc!.pipeline).not.toContain('pulsesrc');
        expect(desc!.pipeline).not.toContain('pulsesink');
        expect(desc!.pipeline).not.toContain('do-timestamp');
    });
});

describe('AudioTranscoderModule re-probe self-heal', () => {
    /** Start a module whose probe returns `codecs` in order (last repeats),
     *  with the base-class pipeline spawn stubbed out. */
    async function startModule(codecs: string[], source: SourceOpts | undefined = {}) {
        const instance = new TestTranscoder();
        instance.codecs = [...codecs];
        const { module, setHealth } = makeModule(source, { instance });
        const superStart = vi
            .spyOn(GstPluginBase.prototype, 'onStart')
            .mockResolvedValue(undefined);
        const superStop = vi.spyOn(GstPluginBase.prototype, 'onStop').mockResolvedValue(undefined);
        await module.onStart();
        return { module, setHealth, superStart, superStop };
    }

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('arms the re-probe timer when the start-time probe returns unknown', async () => {
        const { module } = await startModule(['unknown']);
        expect(module.probeCalls).toBe(1);
        expect(module.reprobe.armed).toBe(true);
        // …and the build it produced is the degraded fallback.
        module.buildPipeline({ renditions: [{ codec: 'opus' }] });
        expect(module.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('re-probing every 10s'),
        );
    });

    it('never arms the timer when the start-time probe identifies the codec', async () => {
        const { module, superStart } = await startModule(['aac']);
        expect(module.reprobe.armed).toBe(false);
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 5);
        expect(module.probeCalls).toBe(1);
        expect(superStart).toHaveBeenCalledTimes(1);
    });

    it('re-asserts the fallback warning on a still-unknown tick, without restarting', async () => {
        const { module, setHealth, superStart, superStop } = await startModule(['unknown']);
        setHealth.mockClear();

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 2);

        expect(module.probeCalls).toBe(3); // start + 2 ticks
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('Source codec unknown'),
        );
        expect(setHealth).toHaveBeenCalledTimes(2);
        expect(superStart).toHaveBeenCalledTimes(1);
        expect(superStop).not.toHaveBeenCalled();
        expect(module.reprobe.armed).toBe(true);
    });

    it('restarts exactly once when a real codec arrives, and disarms', async () => {
        const { module, superStart, superStop } = await startModule(['unknown', 'aac']);
        const onStop = vi.spyOn(module, 'onStop');
        const onStart = vi.spyOn(module, 'onStart');

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(superStop).toHaveBeenCalledTimes(1);
        expect(superStart).toHaveBeenCalledTimes(2); // initial + restart
        expect(module.probeResult).toEqual({ codec: 'aac', rawCaps: '' });
        expect(module.reprobe.armed).toBe(false);

        // Nothing left to fire — the healthy pipeline is never bounced again.
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 5);
        expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('coalesces triggers that land mid-restart into ONE follow-up cycle', async () => {
        const { module, superStart, superStop } = await startModule(['unknown']);
        let release!: () => void;
        superStop.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = () => resolve();
                }),
        );

        const first = module.restartPipeline();
        await vi.advanceTimersByTimeAsync(0);
        // Two more triggers while cycle 1 is mid-flight → exactly one follow-up.
        void module.restartPipeline();
        void module.restartPipeline();
        superStop.mockResolvedValue(undefined);
        release();
        await first;

        expect(superStop).toHaveBeenCalledTimes(2);
        expect(superStart).toHaveBeenCalledTimes(3); // initial + 2 cycles
    });

    it('a follow-up cycle is a no-op once the codec is known (ADR-0005 guard)', async () => {
        const { module, superStop } = await startModule(['unknown', 'aac']);
        let release!: () => void;
        superStop.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = () => resolve();
                }),
        );

        const first = module.restartPipeline();
        await vi.advanceTimersByTimeAsync(0);
        void module.restartPipeline(); // queued follow-up
        superStop.mockResolvedValue(undefined);
        release();
        await first;

        // Cycle 1 re-probed 'aac' → the queued cycle must NOT bounce it.
        expect(superStop).toHaveBeenCalledTimes(1);
        expect(module.probeResult).toEqual({ codec: 'aac', rawCaps: '' });
    });

    it('re-arms after a FAILED restart cycle, so the next tick retries', async () => {
        const { module, superStart, superStop } = await startModule(['unknown', 'aac']);
        // The field shape of a failed cycle: the teardown throws, which skips
        // `onStart`. The loop had already disarmed to run this cycle, so
        // without a re-arm the module stayed degraded forever — contradicting
        // ADR-0009's unbounded wait.
        superStop.mockRejectedValueOnce(new Error('teardown failed'));

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        expect(superStop).toHaveBeenCalledTimes(1);
        expect(superStart).toHaveBeenCalledTimes(1); // start skipped by the throw
        expect(module.reprobe.armed).toBe(true);

        // Next tick retries — EXACTLY one more restart, and it succeeds.
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        expect(superStop).toHaveBeenCalledTimes(2);
        expect(superStart).toHaveBeenCalledTimes(2);
        expect(module.probeResult).toEqual({ codec: 'aac', rawCaps: '' });
        expect(module.reprobe.armed).toBe(false);

        // …and the now-healthy pipeline is never bounced again.
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(superStop).toHaveBeenCalledTimes(2);
    });

    it('an external stop landing mid-restart is never revived by the cycle', async () => {
        const { module, superStart, superStop } = await startModule(['unknown', 'aac']);
        let release!: () => void;
        superStop.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = () => resolve();
                }),
        );

        // Tick 1 probes 'aac' and enters the restart cycle, parking inside its
        // own onStop — past the fallback guard, before onStart.
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        expect(superStop).toHaveBeenCalledTimes(1);

        // The engine stops the module in that window.
        superStop.mockResolvedValue(undefined);
        await module.onStop();
        release();
        await vi.advanceTimersByTimeAsync(0);

        // No revival: the cycle aborted instead of starting a stopped module.
        expect(superStart).toHaveBeenCalledTimes(1);
        expect(module.reprobe.armed).toBe(false);

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(superStart).toHaveBeenCalledTimes(1);
        expect(module.probeCalls).toBe(2); // start + the one tick, nothing after
    });

    it('a cycle that fails after an external stop does not re-arm the loop', async () => {
        const { module, superStop } = await startModule(['unknown', 'aac']);
        let fail!: (err: Error) => void;
        superStop.mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    fail = reject;
                }),
        );

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        superStop.mockResolvedValue(undefined);
        await module.onStop(); // engine-level stop lands mid-cycle
        fail(new Error('teardown failed')); // …and then the cycle fails
        await vi.advanceTimersByTimeAsync(0);

        // Self-heal is for a degraded RUNNING module, not a stopped one.
        expect(module.reprobe.armed).toBe(false);
    });

    it('an external stop then start clears the latch and self-heals normally', async () => {
        const { module, superStart } = await startModule(['unknown']);

        await module.onStop();
        expect(module.reprobe.armed).toBe(false);

        await module.onStart();
        expect(module.probeCalls).toBe(2);
        expect(module.reprobe.armed).toBe(true); // latch cleared, probe unknown

        // The loop still drives a real restart once the codec lands.
        module.codecs = ['aac'];
        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS);
        expect(superStart).toHaveBeenCalledTimes(3); // initial + external + restart
        expect(module.probeResult).toEqual({ codec: 'aac', rawCaps: '' });
        expect(module.reprobe.armed).toBe(false);
    });

    it('an external start after a known-codec stop does not arm the loop', async () => {
        const { module } = await startModule(['unknown']);
        await module.onStop();
        module.codecs = ['aac'];
        await module.onStart();
        expect(module.reprobe.armed).toBe(false);
    });

    it('onStop disarms the timer — no restart lands after the module stopped', async () => {
        const { module, superStart } = await startModule(['unknown', 'aac']);
        expect(module.reprobe.armed).toBe(true);

        await module.onStop();
        expect(module.reprobe.armed).toBe(false);

        await vi.advanceTimersByTimeAsync(REPROBE_INTERVAL_MS * 3);
        expect(module.probeCalls).toBe(1); // no tick ever ran
        expect(superStart).toHaveBeenCalledTimes(1);
    });
});

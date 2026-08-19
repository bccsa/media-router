import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioDecoderModule } from './AudioDecoderModule.js';

function makeModule(
    opts: {
        upstream?: { port: number; socketPath?: string } | null;
        /** Engine-wide time-sync contract (ADR-0005). Off in the legacy tests. */
        timeSyncContract?: boolean;
        /** Engine-wide default playout offset D. */
        playoutOffsetMs?: number;
        /** Override declared by the route head feeding this decoder. */
        routeOffsetMs?: number;
    } = {},
) {
    const module = new AudioDecoderModule() as any;
    const port = opts.upstream?.port ?? 41000;
    const upstream =
        opts.upstream === null
            ? null
            : {
                  port,
                  socketPath: opts.upstream?.socketPath ?? `/tmp/mr-bus-${port}-abc123.sock`,
              };
    const getModuleBusSource = vi.fn(() =>
        upstream === null
            ? undefined
            : {
                  ...upstream,
                  connectionId: 'c-up',
                  sourceModuleId: 'enc-1',
                  sourcePortId: 'mpegts-out',
              },
    );
    const getRoutePlayoutOffsetMs = vi.fn(() => opts.routeOffsetMs);
    module.services = {
        instanceId: 'dec-1',
        mediaRouter: { getModuleBusSource, getRoutePlayoutOffsetMs },
        ...(opts.timeSyncContract ? { timeSyncContract: true } : {}),
        ...(opts.playoutOffsetMs !== undefined
            ? { playoutOffsetMs: opts.playoutOffsetMs }
            : {}),
    };
    module.config = {};
    module.probeResult = null;
    Object.defineProperty(module, 'pwNodeName', {
        value: 'MR_PW_dec-1',
        configurable: true,
    });
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    return { module, getModuleBusSource, setHealth };
}

describe('AudioDecoderModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + warning when no upstream encoder is connected', () => {
        const { module, setHealth } = makeModule({ upstream: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No encoder'));
    });

    it('reads its per-consumer unixfd edge socket with the leaky bus-ingress queue', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain(
            'unixfdsrc socket-path=/tmp/mr-bus-41000-abc123.sock ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0 ! tsdemux',
        );
        expect(desc!.pipeline).not.toContain('udpsrc');
    });

    it.each([
        ['opus', 'opusdec'],
        // libav decoders need framed access units — tsdemux emits unframed ES,
        // so a parser MUST precede the decoder or avdec_aac/a52dec crash-loop.
        ['aac', 'aacparse ! avdec_aac'],
        ['mp2', 'mpegaudioparse ! mpg123audiodec'],
        ['ac3', 'ac3parse ! a52dec'],
    ])('selects the %s decoder (with the codec parser it needs)', (codec, expected) => {
        const { module } = makeModule();
        module.probeResult = { codec };
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain(expected);
    });

    it('puts the parser directly after tsdemux for AAC (unframed → avdec_aac fails without it)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(/tsdemux[^!]*![^!]*queue[^!]*! aacparse ! avdec_aac/);
    });

    it('falls back to decodebin when the probed codec is unknown', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'unknown' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('decodebin');
    });

    it('falls back to decodebin when there is no probe result at all', () => {
        const { module } = makeModule();
        module.probeResult = null;
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('decodebin');
    });

    it('plays sync=false by default — sync=true silently drops ALL audio on any mid-stream join (demuxer restart / decoder respawn)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('pulsesink device=MR_PW_dec-1 sync=false');
        expect(desc!.pipeline).not.toContain('provide-clock=false');
        expect(desc!.clockSync).toBeUndefined();
    });

    it('clockSync=true → sync=true + provide-clock=false + clockSync flag (shared engine clock)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ clockSync: true });
        expect(desc!.pipeline).toContain('pulsesink device=MR_PW_dec-1 sync=true provide-clock=false');
        expect(desc!.clockSync).toBe(true);
    });

    it('default keeps the drop-late guard (max-lateness=200ms) and no ts-offset', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('max-lateness=200000000');
        expect(desc!.pipeline).not.toContain('ts-offset');
    });

    it('lowLatencySync → sync=true + floored ring + max-lateness=-1 (arrival-anchored, never-silent)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ lowLatencySync: true });
        expect(desc!.pipeline).toContain('pulsesink device=MR_PW_dec-1 sync=true');
        expect(desc!.pipeline).not.toContain('provide-clock=false');
        expect(desc!.pipeline).toContain('buffer-time=200000');
        expect(desc!.pipeline).not.toContain('ts-offset');
        expect(desc!.pipeline).toContain('max-lateness=-1');
        expect(desc!.clockSync).toBeUndefined();
    });

    it('lowLatencySync honors syncOffsetMs', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ lowLatencySync: true, syncOffsetMs: 400 });
        expect(desc!.pipeline).toContain('ts-offset=400000000');
    });

    it('clockSync wins over lowLatencySync (no ts-offset in shared-clock mode)', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ clockSync: true, lowLatencySync: true });
        expect(desc!.pipeline).toContain('provide-clock=false');
        expect(desc!.pipeline).not.toContain('ts-offset');
        expect(desc!.pipeline).toContain('max-lateness=200000000');
    });

    it('uses the configured volume (volume=100% → gst volume=1.00)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({ volume: 100 });
        expect(desc!.pipeline).toContain('volume name=vol volume=1.00');
    });

    it('forces gst volume to 0 when audioEnabled is false', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({ volume: 75, audioEnabled: false });
        expect(desc!.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('defaults volume to 100% when not configured', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('volume name=vol volume=1.00');
    });

    it('uses configurable slave-method on pulsesink (default 0 = resample)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        expect(module.buildPipeline({})!.pipeline).toContain('slave-method=0');
        expect(module.buildPipeline({ slaveMethod: 1 })!.pipeline).toContain('slave-method=1');
    });

    it('honours a stored slave-method verbatim on the legacy path', () => {
        // The contract pins skew (below). Off the contract the stored value is
        // the whole answer — including the explicit 0s that `add /modules/<id>`
        // materialised onto the fleet from the schema default, which the
        // kill-switch (MR_TIME_SYNC_CONTRACT=0) has to keep reproducing.
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        expect(module.buildPipeline({ slaveMethod: 0 })!.pipeline).toContain('slave-method=0');
        expect(module.buildPipeline({ slaveMethod: 0 })!.pipeline).not.toContain(
            'slave-method=1',
        );
    });

    it('targets the module-instance null-sink as the pulsesink device', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('pulsesink device=MR_PW_dec-1');
    });

    it('sets restartOnError so transient stream blips auto-recover', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.restartOnError).toBe(true);
    });

    it('emits a NON-leaky dejitter queue after tsdemux so PES bursts are retained for the real-time sink (not dropped)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(/tsdemux[^!]+! queue leaky=0/);
        // Unset bufferMs → safe 300 ms default (bursty demuxer-fed sources).
        expect(desc!.pipeline).toContain('queue leaky=0 max-size-time=300000000');
        // EXPLICIT low values are honoured (trapped fill in this non-leaky
        // queue lands 1:1 as A/V skew on re-encode paths) down to a 50 ms floor.
        const tuned = module.buildPipeline({ bufferMs: 100 });
        expect(tuned!.pipeline).toContain('queue leaky=0 max-size-time=100000000');
        const floored = module.buildPipeline({ bufferMs: 0 });
        expect(floored!.pipeline).toContain('queue leaky=0 max-size-time=50000000');
        // Values above the default pass through (clamped at 5000).
        const raised = module.buildPipeline({ bufferMs: 1500 });
        expect(raised!.pipeline).toContain('queue leaky=0 max-size-time=1500000000');
    });

    it('sinkBufferMs sizes the pa ring (default 200 ms, clamped to 80 ms floor)', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({})!.pipeline).toContain('buffer-time=200000');
        expect(module.buildPipeline({ sinkBufferMs: 100 })!.pipeline).toContain(
            'buffer-time=100000',
        );
        expect(module.buildPipeline({ sinkBufferMs: 10 })!.pipeline).toContain(
            'buffer-time=80000',
        );
        // lowLatencySync honours sinkBufferMs with a 100 ms floor — the old
        // hardcoded 50 ms ring xrunned on the field Pi 4 (audible dropouts).
        const lls = module.buildPipeline({ lowLatencySync: true, sinkBufferMs: 500 });
        expect(lls!.pipeline).toContain('buffer-time=500000');
        const llsThin = module.buildPipeline({ lowLatencySync: true, sinkBufferMs: 80 });
        expect(llsThin!.pipeline).toContain('buffer-time=100000');
    });
});

/**
 * Playout offset D on the audio leg (ADR-0005 decision 4). Under the contract
 * this sink stops choosing its own anchor: it presents at stamped-time + D, D
 * comes from the route (not from this module's settings), and `syncOffsetMs`
 * demotes to a per-sink trim on top. Every legacy shape above is untouched —
 * those tests build with no `timeSyncContract` in services, which is the
 * MR_TIME_SYNC_CONTRACT=0 kill-switch state.
 */
describe('AudioDecoderModule playout offset (time-sync contract)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('paces at the engine default D with no route override', () => {
        const { module } = makeModule({ timeSyncContract: true, playoutOffsetMs: 300 });
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('ts-offset=300000000');
    });

    it('presents sync=true with the never-silent guard, whatever the legacy mode flags say', () => {
        // sync=false would ignore ts-offset outright and leave this leg
        // arrival-anchored while the video leg paced off the house clock.
        const { module } = makeModule({ timeSyncContract: true, playoutOffsetMs: 300 });
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('pulsesink name=sink device=MR_PW_dec-1 sync=true provide-clock=false');
        expect(desc!.pipeline).toContain('max-lateness=-1');
        expect(desc!.pipeline).not.toContain('max-lateness=200000000');
        // Paced ⇒ the ring takes the 100 ms floor, as on lowLatencySync.
        expect(module.buildPipeline({ sinkBufferMs: 80 })!.pipeline).toContain(
            'buffer-time=100000',
        );
    });

    it('slaves the DAC to the house clock with slave-method=skew, whatever is stored', () => {
        // ADR-0005 decision 5: under the contract the house clock is the master
        // and the DAC slaves to it by SKEW. Resample would absorb the rate
        // difference by rewriting samples, so this sink would drift off the time
        // it was told to present at and D would stop meaning what the route
        // configured — on this leg only, while the video leg held the clock.
        // The stored value is ignored rather than defaulted from: fleet configs
        // carry materialised `slaveMethod: 0`s nobody chose.
        const { module } = makeModule({ timeSyncContract: true, playoutOffsetMs: 300 });
        module.probeResult = { codec: 'opus' };
        expect(module.buildPipeline({})!.pipeline).toContain('slave-method=1');
        expect(module.buildPipeline({ slaveMethod: 0 })!.pipeline).toContain('slave-method=1');
        expect(module.buildPipeline({ slaveMethod: 0 })!.pipeline).not.toContain(
            'slave-method=0',
        );
    });

    it('names the sink so the offset can be pushed live', () => {
        const { module } = makeModule({ timeSyncContract: true });
        expect(module.buildPipeline({})!.pipeline).toContain('pulsesink name=sink');
    });

    it('lets the route head override win over the engine default', () => {
        const { module } = makeModule({
            timeSyncContract: true,
            playoutOffsetMs: 300,
            routeOffsetMs: 500,
        });
        expect(module.buildPipeline({})!.pipeline).toContain('ts-offset=500000000');
    });

    it('adds syncOffsetMs on top of D as a deprecated per-sink trim', () => {
        const { module } = makeModule({
            timeSyncContract: true,
            playoutOffsetMs: 300,
            routeOffsetMs: 500,
        });
        expect(module.buildPipeline({ syncOffsetMs: 40 })!.pipeline).toContain(
            'ts-offset=540000000',
        );
    });

    it('resolves the offset through the route this decoder consumes', () => {
        const { module } = makeModule({ timeSyncContract: true, routeOffsetMs: 250 });
        module.buildPipeline({});
        expect(module.services.mediaRouter.getRoutePlayoutOffsetMs).toHaveBeenCalledWith(
            'dec-1',
            undefined,
        );
    });

    it('pushes a route offset change to the live sink without a rebuild', async () => {
        const { module } = makeModule({ timeSyncContract: true, routeOffsetMs: 500 });
        const setElementProperty = vi.fn();
        module.setElementProperty = setElementProperty;
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenCalledWith('sink', 'ts-offset', 500_000_000);
    });

    it('pushes a syncOffsetMs trim live too, resolved whole against the route', async () => {
        const { module } = makeModule({ timeSyncContract: true, routeOffsetMs: 500 });
        const setElementProperty = vi.fn();
        module.setElementProperty = setElementProperty;
        await module.onLiveConfigUpdate({ syncOffsetMs: 40 });
        expect(setElementProperty).toHaveBeenCalledWith('sink', 'ts-offset', 540_000_000);
    });

    it('arms the backlog shedder on its own sink, without keyframe alignment', () => {
        // The contract's latency ratchet guard (backlogShed.ts). This leg's
        // `max-lateness=-1` makes the ratchet quieter than the video leg's, not
        // absent: the sink refuses to drop late buffers, so retained latency
        // shows up as lipsync drift against the video leg of the SAME route.
        // The shed point is the sink's own pad — raw PCM references nothing, so
        // whole decoded buffers can be dropped and no sample is ever cut.
        const { module } = makeModule({ timeSyncContract: true, playoutOffsetMs: 300 });
        expect(module.buildPipeline({})!.backlogShed).toMatchObject({
            element: 'sink',
            sink: 'sink',
            keyframeAligned: false,
        });
    });

    it('never arms the shedder on the legacy path', () => {
        // Nothing to guard: a `sync=false` sink presents on arrival and drains
        // its own backlog. `MR_TIME_SYNC_CONTRACT=0` must reproduce the legacy
        // description exactly.
        const { module } = makeModule();
        expect(module.buildPipeline({})!.backlogShed).toBeUndefined();
        expect(module.buildPipeline({ lowLatencySync: true })!.backlogShed).toBeUndefined();
        expect(module.buildPipeline({ clockSync: true })!.backlogShed).toBeUndefined();
    });

    it('never pushes on the legacy path — that sink has no name to address', async () => {
        const { module } = makeModule();
        const setElementProperty = vi.fn();
        module.setElementProperty = setElementProperty;
        await module.onRoutePlayoutOffsetChanged();
        await module.onLiveConfigUpdate({ syncOffsetMs: 40 });
        expect(setElementProperty).not.toHaveBeenCalledWith(
            'sink',
            'ts-offset',
            expect.anything(),
        );
    });
});

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

function makeModule(
    opts: {
        sources?: number;
        /** Turn the engine-wide time-sync contract on, with the engine default D
         *  (ms) and an optional route-head override. */
        contract?: { playoutOffsetMs?: number; routeOverrideMs?: number };
    } = {},
) {
    const module = new AudioOutput302mModule() as any;
    const sources = Array.from({ length: opts.sources ?? 0 }, (_, i) => ({
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
    }));
    const getRoutePlayoutOffsetMs = vi.fn(() => opts.contract?.routeOverrideMs);
    module.services = {
        instanceId: 'aout-1',
        mediaRouter: { getModuleBusSources: vi.fn(() => sources), getRoutePlayoutOffsetMs },
        ...(opts.contract
            ? { timeSyncContract: true, playoutOffsetMs: opts.contract.playoutOffsetMs ?? 300 }
            : {}),
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    const setElementProperty = vi.fn(async () => undefined);
    module.setElementProperty = setElementProperty;
    return { module, setHealth, setElementProperty, getRoutePlayoutOffsetMs };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioOutput302mModule.buildPipeline', () => {
    it('never plays to a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule({ sources: 1 });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
    });

    it('returns null + warning with no 302M sources', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No 302M'));
    });

    it('mixes N sources and plays to the EXPLICIT device with volume + VU in-pipeline', () => {
        const { module } = makeModule({ sources: 2 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', volume: 80 });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('audiomixer name=mixin force-live=true');
        expect(desc!.pipeline.match(/! mixin\./g)).toHaveLength(2);
        // `pulsesink sync=false` paces nothing, so the mixer carries its own
        // clock pacer — without it a force-live mixer whose inputs have all
        // gone EOS generates silence at CPU speed.
        expect(desc!.pipeline).toContain('identity name=mixin_out sync=true');
        expect(desc!.pipeline).toContain('volume name=vol volume=0.80');
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain('pulsesink device=alsa_output.usb-foo sync=false');
        expect(desc!.restartOnError).toBe(true);
    });

    it('mutes via the gst volume element when audioEnabled=false', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            volume: 90,
            audioEnabled: false,
        });
        expect(desc!.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('a single source plays direct — no mixer, no mix latency', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            mixLatencyMs: 400,
        });
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.pipeline).not.toContain('latency=400000000');
        expect(desc!.pipeline).toContain('capsfilter name=mixin_out');
        expect(desc!.pipeline).toContain('mixin_out. ! audioconvert ! audioresample');
        expect(desc!.pipeline).toContain('pulsesink device=alsa_output.usb-foo sync=false');
    });

    it('consumes the per-connection unixfd edge sockets', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-40100-x.sock');
    });

    it('contract OFF: no backlog shedder, no named sink — the legacy string is untouched', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: 80 });
        expect(desc!.pipeline).toContain('! pulsesink device=alsa_output.usb-foo sync=false');
        expect(desc!.pipeline).not.toContain('name=sink');
        expect(desc!.pipeline).not.toContain('ts-offset');
        expect(desc!.backlogShed).toBeUndefined();
        expect(desc!.alignBranchesToStamps).toBeUndefined();
    });
});

describe('AudioOutput302mModule.buildPipeline — time-sync contract (ADR-0005)', () => {
    it('presents at stamp + D on the house clock: sync=true, ts-offset=D minus the ring it declares, skew-slaved, never drops late', () => {
        const { module } = makeModule({ sources: 1, contract: { playoutOffsetMs: 300 } });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain(
            '! pulsesink name=sink device=alsa_output.usb-foo sync=true provide-clock=false' +
                ' slave-method=1 max-lateness=-1 buffer-time=100000 ts-offset=200000000',
        );
        expect(desc!.pipeline).not.toContain('sync=false');
        // The contract's latency-ratchet guard, on the sink's own pad, whole-buffer.
        expect(desc!.backlogShed).toMatchObject({
            element: 'sink',
            sink: 'sink',
            keyframeAligned: false,
        });
        // …and the branch anchored to the producer's stamps, like the muxer's inputs.
        expect(desc!.pipeline).toContain('tsdemux name=mixin_demux0 latency=0');
        expect(desc!.alignBranchesToStamps).toEqual({ demuxes: ['mixin_demux0'] });
    });

    it('the route head override replaces the engine default — resolved for THIS consumer', () => {
        const { module, getRoutePlayoutOffsetMs } = makeModule({
            sources: 1,
            contract: { playoutOffsetMs: 300, routeOverrideMs: 500 },
        });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain('ts-offset=400000000');
        expect(getRoutePlayoutOffsetMs).toHaveBeenCalledWith('aout-1', undefined);
    });

    it('lipSyncMs is a per-sink trim on top of D — positive delays audio, negative advances it', () => {
        const { module } = makeModule({ sources: 1, contract: { playoutOffsetMs: 300 } });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: -110 })!.pipeline,
        ).toContain('ts-offset=90000000');
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: 40 })!.pipeline,
        ).toContain('ts-offset=240000000');
    });

    it('never emits a negative ts-offset: a trim past D clamps to 0 (audio cannot play before it arrives)', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 1,
            contract: { playoutOffsetMs: 300 },
        });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: -2000 })!.pipeline,
        ).toContain('ts-offset=0');
        // …and the live push clamps the same way — the shedder reads ts-offset
        // as the budget, so a negative value would make it drop real audio.
        module.config = { device: 'alsa_output.usb-foo', lipSyncMs: -2000 };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 0);
    });

    it('the mixer arm subtracts its declared aggregation latency, so both arms play at stamp + D', () => {
        const { module } = makeModule({ sources: 2, contract: { playoutOffsetMs: 300 } });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', mixLatencyMs: 100 });
        // audiomixer latency=100 ms is pipeline latency a sync=true sink adds
        // to every render time; the offset gives it back (300 − 100 mixer − 100 ring).
        expect(desc!.pipeline).toContain('audiomixer name=mixin force-live=true latency=100000000');
        expect(desc!.pipeline).toContain('identity name=mixin_out sync=true');
        expect(desc!.pipeline).toContain('ts-offset=100000000');
    });

    it('re-pushes ts-offset live when the route D or the trim changes; never on the legacy path', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 1,
            contract: { playoutOffsetMs: 300 },
        });
        module.config = { device: 'alsa_output.usb-foo', lipSyncMs: 0 };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 200000000);
        await module.onLiveConfigUpdate({ lipSyncMs: 50 });
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 250000000);

        const legacy = makeModule({ sources: 1 });
        legacy.module.config = { device: 'alsa_output.usb-foo' };
        legacy.module.buildPipeline(legacy.module.config);
        await legacy.module.onRoutePlayoutOffsetChanged();
        await legacy.module.onLiveConfigUpdate({ lipSyncMs: 50 });
        expect(legacy.setElementProperty).not.toHaveBeenCalled();
    });

    it('a live push through the mixer arm keeps the latency subtraction the build applied', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 2,
            contract: { playoutOffsetMs: 300 },
        });
        module.config = { device: 'alsa_output.usb-foo', mixLatencyMs: 100 };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 100000000);
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioDecoderModule } from './AudioDecoderModule.js';

function makeModule(opts: { upstream?: { host: string; port: number } | null } = {}) {
    const module = new AudioDecoderModule() as any;
    const upstream =
        opts.upstream === null
            ? null
            : { host: opts.upstream?.host ?? '239.255.0.1', port: opts.upstream?.port ?? 41000 };
    const getModuleUdpSource = vi.fn(() =>
        upstream === null
            ? undefined
            : {
                  ...upstream,
                  connectionId: 'c-up',
                  sourceModuleId: 'enc-1',
                  sourcePortId: 'mpegts-out',
              },
    );
    module.services = {
        instanceId: 'dec-1',
        mediaRouter: { getModuleUdpSource },
    };
    module.config = {};
    module.probeResult = null;
    Object.defineProperty(module, 'pwNodeName', {
        value: 'MR_PW_dec-1',
        configurable: true,
    });
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    return { module, getModuleUdpSource, setHealth };
}

describe('AudioDecoderModule.buildPipeline', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null + warning when no upstream encoder is connected', () => {
        const { module, setHealth } = makeModule({ upstream: null });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No encoder'));
    });

    it.each([
        ['opus', 'opusdec'],
        ['aac', 'avdec_aac'],
        ['mp2', 'mpegaudioparse ! mpg123audiodec'],
        ['ac3', 'a52dec'],
    ])('selects the %s decoder', (codec, expected) => {
        const { module } = makeModule();
        module.probeResult = { codec };
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain(expected);
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

    it('plays sync=false with no clockSync by default (standalone/low-latency)', () => {
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

    it('targets the module-instance null-sink as the pulsesink device', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('pulsesink device=MR_PW_dec-1');
    });

    it('exposes vol.volume as a live-updatable property', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.liveElements).toEqual({ vol: ['volume'] });
    });

    it('sets restartOnError so transient stream blips auto-recover', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.restartOnError).toBe(true);
    });

    it('emits a queue with leaky=2 after tsdemux so decoder backpressure does not accumulate latency', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(/tsdemux[^!]+! queue leaky=2/);
    });
});

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

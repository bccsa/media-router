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
        // Default 1000 ms non-leaky cap (a safety bound, not steady-state latency).
        expect(desc!.pipeline).toContain('queue leaky=0 max-size-time=1000000000');
        // Operator bufferMs floored at 300 ms: small values were tuned as the OLD
        // leaky latency bound and would re-starve the sink as a non-leaky burst cap.
        const floored = module.buildPipeline({ bufferMs: 100 });
        expect(floored!.pipeline).toContain('queue leaky=0 max-size-time=300000000');
    });
});

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

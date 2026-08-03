import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioDecoderModule } from './AudioDecoderModule.js';

function makeModule(opts: { upstream?: { port: number; socketPath?: string } | null } = {}) {
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
    module.services = {
        instanceId: 'dec-1',
        mediaRouter: { getModuleBusSource },
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

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

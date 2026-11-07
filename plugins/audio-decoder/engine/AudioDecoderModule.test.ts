import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A pass-through spy, so one case can build without the lateness instrument.
vi.mock('@media-router/engine', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        buildLatenessTap: vi.fn(actual.buildLatenessTap as (...a: unknown[]) => unknown),
    };
});

import { buildLatenessTap } from '@media-router/engine';
import { AudioDecoderModule } from './AudioDecoderModule.js';

/** The bus ingress of `makeModule()`'s edge, as `buildBusSrc` builds it. */
const BUS_IN =
    'unixfdsrc socket-path=/tmp/mr-bus-41000-abc123.sock ! mrlateness name=lat_busin_41000_676b67 reference=house ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000';

/** The whole string for one decoder branch (house-clock part 4.1, B-168). */
function decodeString(decoder: string): string {
    return (
        `${BUS_IN} ! mrtsdemux name=addemux media=audio ! queue name=ad_esq leaky=0 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000 ! ${decoder}` +
        ' ! audioconvert ! mrlateness name=lat_render reference=running-time ! mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink' +
        ' ! audioconvert ! volume name=vol volume=1.00 ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ' ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000 max-size-buffers=0 max-size-bytes=0' +
        ' ! pulsesink name=sink device=MR_PW_dec-1 sync=false provide-clock=false processing-deadline=100000000 buffer-time=100000' +
        ' stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"'
    );
}

/** The decoder branches by the codec the probe reports ('unknown': decodebin). */
const BRANCHES = [
    ['opus', 'opusdec'],
    // libav decoders need framed access units — the demux emits unframed ES,
    // so a parser MUST precede the decoder or avdec_aac/a52dec crash-loop.
    ['aac', 'aacparse ! avdec_aac'],
    ['mp2', 'mpegaudioparse ! mpg123audiodec'],
    ['ac3', 'ac3parse ! a52dec'],
    ['unknown', 'decodebin'],
] as const;

function makeModule(
    opts: {
        upstream?: { port: number; socketPath?: string } | null;
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
    module.services = { instanceId: 'dec-1', mediaRouter: { getModuleBusSource } };
    module.config = {};
    module.probeResult = null;
    Object.defineProperty(module, 'pwNodeName', {
        value: 'MR_PW_dec-1',
        configurable: true,
    });
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    const setElementProperty = vi.fn(async () => {});
    module.setElementProperty = setElementProperty;
    return { module, getModuleBusSource, setHealth, setElementProperty };
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
        expect(desc!.pipeline).toContain(`${BUS_IN} ! mrtsdemux`);
        expect(desc!.pipeline).not.toContain('udpsrc');
    });

    it.each(BRANCHES)(
        'builds the %s branch: first audio stream, decoder, audioconvert, the ASRC, the prefill, the sink',
        (codec, decoder) => {
            // House-clock WI-P3-10 (part 4.3, S15): `audioconvert` before `mrasrc`, whose caps are
            // interleaved only; the render tap before it; one ASRC for the source's and the sink's clock.
            const { module } = makeModule();
            module.probeResult = { codec };
            expect(module.buildPipeline({})!.pipeline).toBe(decodeString(decoder));
        },
    );

    it('puts the parser directly after the ES queue for AAC (unframed → avdec_aac fails without it)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(
            /mrtsdemux[^!]*![^!]*queue name=ad_esq [^!]*! aacparse ! avdec_aac/,
        );
    });

    it('converts every decoder output to interleaved before the ASRC (avdec_aac is planar)', () => {
        const { module } = makeModule();
        for (const codec of ['opus', 'aac', 'mp2', 'ac3', 'unknown']) {
            module.probeResult = { codec };
            expect(module.buildPipeline({})!.pipeline).toMatch(
                /! (opusdec|avdec_aac|mpg123audiodec|a52dec|decodebin) ! audioconvert ! mrlateness name=lat_render [^!]*! mrasrc name=asrc /,
            );
        }
    });

    it('goes straight from audioconvert to the ASRC without the lateness instrument', () => {
        vi.mocked(buildLatenessTap).mockReturnValueOnce(null);
        const { module } = makeModule();
        module.probeResult = { codec: 'aac' };
        const p = module.buildPipeline({})!.pipeline;
        expect(p).toContain('! avdec_aac ! audioconvert ! mrasrc name=asrc ');
        expect(p).not.toContain('lat_render');
        expect(p).not.toMatch(/!\s*(null\s*)?!/);
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

    it('pins the playback stream to its own null-sink (#736)', () => {
        const desc = makeModule().module.buildPipeline({});
        expect(desc!.pipeline).toMatch(
            /pulsesink name=sink device=MR_PW_dec-1 [^!]*stream-properties="props,node.dont-fallback=\(string\)true,node.linger=\(string\)true"/,
        );
    });

    it('targets the module-instance null-sink as the pulsesink device', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('pulsesink name=sink device=MR_PW_dec-1');
    });

    it('sets restartOnError so transient stream blips auto-recover', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.restartOnError).toBe(true);
    });
});

/** House-clock part 4.1 (WI-P4-7, B-168): no playout offset, no trim, no shedder, no relaunch. */
describe('AudioDecoderModule plays as soon as it can (B-168)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('each branch: ad_esq, lat_render, asrc on the sink, the VU, the 40 ms prefill, a sync=false sink; nothing that waits or drops', () => {
        for (const [codec] of BRANCHES) {
            const { module } = makeModule();
            module.probeResult = { codec };
            const desc = module.buildPipeline({})!;
            const p: string = desc.pipeline;
            const at = (s: string): number => p.indexOf(s);
            // The compressed backlog waits after the demux, never leaked (part 4.4, ADR-0015's byte cap).
            expect(p).toContain(
                ' ! mrtsdemux name=addemux media=audio ! queue name=ad_esq leaky=0 max-size-time=5000000000' +
                    ' max-size-buffers=0 max-size-bytes=40000000 ! ',
            );
            // Render lateness before the ASRC, where PTS is still content time (part 4.4).
            expect(p).toContain(
                '! audioconvert ! mrlateness name=lat_render reference=running-time ! mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink ! ',
            );
            expect(at('lat_render')).toBeLessThan(at('mrasrc'));
            expect(p).toContain(
                ' ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000' +
                    ' max-size-buffers=0 max-size-bytes=0 ! pulsesink name=sink device=MR_PW_dec-1' +
                    ' sync=false provide-clock=false processing-deadline=100000000 buffer-time=100000 stream-properties=',
            );
            expect(at(' ! queue name=prefill ')).toBeGreaterThan(at('level post-messages=true'));
            for (const gone of [
                'ts-offset',
                'slave-method',
                'max-lateness',
                'sync=true',
                'audioresample',
            ]) {
                expect(p).not.toContain(gone);
            }
            // The only leaky queue is the bus ingress backstop (OQ-30).
            expect(p.match(/\bleaky=[12]\b/g)).toEqual(['leaky=2']);
            expect(p.match(/\bmrasrc /g)).toHaveLength(1);
            expect(desc.timingSink).toEqual({ element: 'sink', kind: 'audio' });
            // No launch catch-up: a launch measured no start backlog to skip (B-168).
            expect(desc.catchUp).toBeUndefined();
        }
    });

    it('stored legacy keys build the same string: Buffer, Sink Buffer, Low-Latency Sync, Sync Method', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'aac' };
        const plain = module.buildPipeline({})!.pipeline;
        for (const stored of [
            { bufferMs: 0 },
            { bufferMs: 100 },
            { bufferMs: 1500 },
            { bufferMs: 5000 },
            { sinkBufferMs: 80 },
            { sinkBufferMs: 400 },
            { lowLatencySync: true },
            { lowLatencySync: false },
            { slaveMethod: 2 },
            { clockSync: true },
        ]) {
            expect(module.buildPipeline(stored)!.pipeline).toBe(plain);
        }
    });

    it('none of the three is in the manifest, nor Sync Method (WI-P3-10)', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        const props = manifest.mediaRouter.configSchema.properties;
        for (const key of ['bufferMs', 'sinkBufferMs', 'lowLatencySync', 'slaveMethod']) {
            expect(props).not.toHaveProperty(key);
        }
    });

    it('only volume and audioEnabled are live: nothing else reaches the sink (B-168)', () => {
        const { module } = makeModule();
        expect(module.liveUpdatableParams).toEqual(['volume', 'audioEnabled']);
    });

    it('volume is still live, on the gst volume element', async () => {
        const { module, setElementProperty } = makeModule();
        await module.onLiveConfigUpdate({ volume: 40 });
        expect(setElementProperty).toHaveBeenLastCalledWith('vol', 'volume', 0.4);
        await module.onLiveConfigUpdate({ audioEnabled: false });
        expect(setElementProperty).toHaveBeenLastCalledWith('vol', 'volume', 0);
    });

    it('FF9 is gone (B-184): a 6 s pause in the meter relaunches nothing in 70 s', () => {
        vi.useFakeTimers();
        try {
            const { module } = makeModule();
            const restartPipeline = vi.fn(async () => {});
            module.childProcess = {
                isRunning: true,
                pipelineLaunchedAt: Date.now(),
                restartPipeline,
            };
            module.onPipelinePlaying();
            for (let t = 0; t < 70_000; t += 100) {
                if (t < 2000 || t >= 8000) module.setVuData([-20, -20]);
                vi.advanceTimersByTime(100);
            }
            expect(restartPipeline).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("follows the sink's clock through the ASRC on a timer: one mrasrc, no slave-method (B-166)", () => {
        // House-clock part 4.4 (C-6), ch. 8 WI-P4-4: `asrc` reads the sink's clock on a timer and
        // resamples by the product of that and its source's term, so the sink is never asked to skew
        // and no sample is dropped or repeated for drift.
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const p = module.buildPipeline({})!.pipeline;
        expect(p).toContain('mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink !');
        expect(p).toContain('pulsesink name=sink device=MR_PW_dec-1 sync=false ');
        expect(p).not.toContain('slave-method');
        expect(p.match(/\bmrasrc /g)).toHaveLength(1);
    });

    it('decodes its first audio stream on the formula demux', () => {
        // House-clock WI-P3-10 (OQ-28): `media=audio`, so an A/V input never links its video
        // first; content time comes from the demux's formula, nothing to align.
        const { module } = makeModule();
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain(
            ' ! mrtsdemux name=addemux media=audio ! queue name=ad_esq ',
        );
        expect(desc.pipeline).not.toMatch(/\btsdemux\b/);
    });
});

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

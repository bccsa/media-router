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

/** The whole string at D = 300 ms with the default queue, for one decoder branch. */
function decodeString(decoder: string): string {
    return (
        `${BUS_IN} ! mrtsdemux name=addemux media=audio ! queue leaky=0 max-size-time=300000000 max-size-buffers=0 max-size-bytes=0 ! ${decoder}` +
        ' ! audioconvert ! mrlateness name=lat_render reference=running-time ! mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink' +
        ' ! audioconvert ! volume name=vol volume=1.00 ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
        ' ! pulsesink name=sink device=MR_PW_dec-1 sync=true provide-clock=false slave-method=3 processing-deadline=100000000 buffer-time=100000 ts-offset=200000000 max-lateness=-1' +
        ' stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"'
    );
}

function makeModule(
    opts: {
        upstream?: { port: number; socketPath?: string } | null;
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
        ...(opts.playoutOffsetMs !== undefined ? { playoutOffsetMs: opts.playoutOffsetMs } : {}),
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
        expect(desc!.pipeline).toContain(`${BUS_IN} ! mrtsdemux`);
        expect(desc!.pipeline).not.toContain('udpsrc');
    });

    it.each([
        ['opus', 'opusdec'],
        // libav decoders need framed access units — the demux emits unframed ES,
        // so a parser MUST precede the decoder or avdec_aac/a52dec crash-loop.
        ['aac', 'aacparse ! avdec_aac'],
        ['mp2', 'mpegaudioparse ! mpg123audiodec'],
        ['ac3', 'ac3parse ! a52dec'],
        ['unknown', 'decodebin'],
    ])('builds the %s branch: first audio stream, decoder, audioconvert, the ASRC, the sink', (codec, decoder) => {
        // House-clock WI-P3-10 (part 4.3, S15): `audioconvert` before `mrasrc`, whose caps are
        // interleaved only; the render tap before it; one ASRC for the source's and the sink's clock.
        const { module } = makeModule({ playoutOffsetMs: 300 });
        module.probeResult = { codec };
        expect(module.buildPipeline({})!.pipeline).toBe(decodeString(decoder));
    });

    it('puts the parser directly after the demux for AAC (unframed → avdec_aac fails without it)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'aac' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(/mrtsdemux[^!]*![^!]*queue[^!]*! aacparse ! avdec_aac/);
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

    it('emits a NON-leaky dejitter queue after the demux so PES bursts are retained for the real-time sink (not dropped)', () => {
        const { module } = makeModule();
        module.probeResult = { codec: 'opus' };
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toMatch(/mrtsdemux[^!]+! queue leaky=0/);
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
});

/**
 * Playout offset D on the audio leg (ADR-0005 decision 4). This sink does not choose its own
 * anchor: it presents at stamped-time + D, D comes from the route (not from this module's
 * settings), and `syncOffsetMs` demotes to a per-sink trim on top.
 */
describe('AudioDecoderModule playout offset', () => {
    beforeEach(() => vi.clearAllMocks());

    it('paces at the engine default D with no route override', () => {
        const { module } = makeModule({ playoutOffsetMs: 300 });
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain('ts-offset=200000000');
    });

    it('cancels the latency its paced ring declares, so it lands on D like the 302M leg', () => {
        // D 300 − 100 ms declared ring = 200 ms of scheduling offset, and the
        // ring is PINNED so both audio legs cancel the same
        // number (ADR-0005 decision 4 — one route, one D on every leg).
        const { module } = makeModule({ playoutOffsetMs: 300 });
        expect(module.buildPipeline({})!.pipeline).toContain('buffer-time=100000');
        expect(module.buildPipeline({ sinkBufferMs: 400 })!.pipeline).toContain(
            'buffer-time=100000',
        );
        // …and a D at or under the ring clamps to 0 rather than going negative
        // (the shedder reads ts-offset as its budget).
        const tight = makeModule({ playoutOffsetMs: 80 });
        expect(tight.module.buildPipeline({})!.pipeline).toContain('ts-offset=0');
    });

    it('decodes its first audio stream on the formula demux, with no branch alignment', () => {
        // House-clock WI-P3-10 (OQ-28): `media=audio`, so an A/V input never links its video
        // first; content time comes from the demux's formula, nothing to align.
        const { module } = makeModule({ playoutOffsetMs: 300 });
        const desc = module.buildPipeline({})!;
        expect(desc.pipeline).toContain(' ! mrtsdemux name=addemux media=audio ! queue leaky=0 ');
        expect(desc.pipeline).not.toMatch(/\btsdemux\b/);
        expect(desc.pipeline).not.toContain('audioresample');
        expect(desc).not.toHaveProperty('alignBranchesToStamps');
    });

    it('presents sync=true with the never-silent guard, whatever the stored mode flags say', () => {
        // sync=false would ignore ts-offset outright and leave this leg
        // arrival-anchored while the video leg paced off the house clock.
        const { module } = makeModule({ playoutOffsetMs: 300 });
        const desc = module.buildPipeline({});
        expect(desc!.pipeline).toContain(
            'pulsesink name=sink device=MR_PW_dec-1 sync=true provide-clock=false',
        );
        // Render lateness before the ASRC, where PTS is still content time (part 4.4): after its
        // device term the PTS are device-time labels.
        expect(desc!.pipeline).toContain(
            '! audioconvert ! mrlateness name=lat_render reference=running-time ! mrasrc name=asrc ',
        );
        expect(desc!.pipeline.indexOf('lat_render')).toBeLessThan(desc!.pipeline.indexOf('mrasrc'));
        expect(desc!.timingSink).toEqual({ element: 'sink', kind: 'audio' });
        expect(desc!.pipeline).toContain('max-lateness=-1');
        expect(desc!.pipeline).not.toContain('max-lateness=200000000');
        // Stored legacy modes are ignored: the paced ring is pinned.
        for (const stored of [{ sinkBufferMs: 80 }, { lowLatencySync: true, syncOffsetMs: 0 }]) {
            const p = module.buildPipeline(stored)!.pipeline;
            expect(p).toContain('sync=true provide-clock=false');
            expect(p).toContain('buffer-time=100000');
            expect(p).toContain('ts-offset=200000000');
        }
    });

    it("follows the sink's clock through the ASRC's custom slaving, never skew", () => {
        // House-clock part 4.4 (C-6): `asrc` reads the sink's clock through its custom-slaving
        // callback and resamples by the product of that and its source's term, so the sink is never
        // asked to skew and no sample is dropped or repeated for drift.
        const { module } = makeModule({ playoutOffsetMs: 300 });
        module.probeResult = { codec: 'opus' };
        const p = module.buildPipeline({})!.pipeline;
        expect(p).toContain('mrasrc name=asrc bypass-below-ppm=0.5 device-sink=sink !');
        expect(p).toContain('pulsesink name=sink device=MR_PW_dec-1 ');
        expect(p).toContain(' slave-method=3 ');
        expect(p).not.toMatch(/slave-method=[^3]/);
        expect(p.match(/\bmrasrc /g)).toHaveLength(1);
    });

    it('has no Sync Method setting, and ignores a stored one (WI-P3-10, S31)', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        expect(manifest.mediaRouter.configSchema.properties).not.toHaveProperty('slaveMethod');
        const { module } = makeModule({ playoutOffsetMs: 300 });
        module.probeResult = { codec: 'opus' };
        const plain = module.buildPipeline({})!.pipeline;
        for (const slaveMethod of [0, 1, 2]) {
            expect(module.buildPipeline({ slaveMethod })!.pipeline).toBe(plain);
        }
    });

    it('names the sink so the offset can be pushed live', () => {
        const { module } = makeModule();
        expect(module.buildPipeline({})!.pipeline).toContain('pulsesink name=sink');
    });

    it('lets the route head override win over the engine default', () => {
        const { module } = makeModule({
            playoutOffsetMs: 300,
            routeOffsetMs: 500,
        });
        expect(module.buildPipeline({})!.pipeline).toContain('ts-offset=400000000');
    });

    it('adds syncOffsetMs on top of D as a deprecated per-sink trim', () => {
        const { module } = makeModule({
            playoutOffsetMs: 300,
            routeOffsetMs: 500,
        });
        expect(module.buildPipeline({ syncOffsetMs: 40 })!.pipeline).toContain(
            'ts-offset=440000000',
        );
    });

    it('resolves the offset through the route this decoder consumes', () => {
        const { module } = makeModule({ routeOffsetMs: 250 });
        module.buildPipeline({});
        expect(module.services.mediaRouter.getRoutePlayoutOffsetMs).toHaveBeenCalledWith(
            'dec-1',
            undefined,
        );
    });

    it('pushes a route offset change to the live sink without a rebuild', async () => {
        const { module } = makeModule({ routeOffsetMs: 500 });
        const setElementProperty = vi.fn();
        module.setElementProperty = setElementProperty;
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenCalledWith('sink', 'ts-offset', 400_000_000);
    });

    it('pushes a syncOffsetMs trim live too, resolved whole against the route', async () => {
        const { module } = makeModule({ routeOffsetMs: 500 });
        const setElementProperty = vi.fn();
        module.setElementProperty = setElementProperty;
        await module.onLiveConfigUpdate({ syncOffsetMs: 40 });
        expect(setElementProperty).toHaveBeenCalledWith('sink', 'ts-offset', 440_000_000);
    });

    it("arms the backlog shedder at the ASRC's input against the sink's budget, without keyframe alignment", () => {
        // The latency ratchet guard (backlogShed.ts). This leg's
        // `max-lateness=-1` makes the ratchet quieter than the video leg's, not
        // absent: the sink refuses to drop late buffers, so retained latency
        // shows up as lipsync drift against the video leg of the SAME route.
        // The shed point is `asrc`'s input, the last pad on content time: after its device
        // term the PTS are device-time labels, which drift with the device (B-127).
        const { module } = makeModule({ playoutOffsetMs: 300 });
        expect(module.buildPipeline({})!.backlogShed).toMatchObject({
            element: 'asrc',
            sink: 'sink',
            keyframeAligned: false,
        });
    });

    // Never drop on lateness (ADR-0005 amendment 2026-10-08): with the engine's
    // re-anchor switch on, the same shed point asks the runner to RAISE the
    // route's D instead; off (MR_PLAYOUT_REANCHOR=0) the config is as before.
    it('re-anchor on: the shedder config carries onLateness and the five numbers', () => {
        const { module } = makeModule({ playoutOffsetMs: 300 });
        module.services.playoutReanchor = true;
        expect(module.buildPipeline({})!.backlogShed).toMatchObject({
            element: 'asrc',
            sink: 'sink',
            keyframeAligned: false,
            onLateness: 'reanchor',
            reanchorToleranceMs: 40,
            reanchorHoldMs: 15000,
            reanchorRetryMs: 30000,
            rebaseHoldMs: 3000,
            rebaseCooldownMs: 60000,
        });
    });

    it('re-anchor off: none of the re-anchor keys', () => {
        const { module } = makeModule({ playoutOffsetMs: 300 });
        expect(module.buildPipeline({})!.backlogShed).not.toHaveProperty('onLateness');
    });
});

describe('AudioDecoderModule.getPipeWireNodes', () => {
    it('exposes the null-sink monitor as the source for downstream modules', () => {
        const { module } = makeModule();
        expect(module.getPipeWireNodes()).toEqual({ source: 'MR_PW_dec-1.monitor' });
    });
});

import { describe, expect, it, vi } from 'vitest';
import { Aes67OutputModule } from '../../../../../plugins/aes67-output/engine/Aes67OutputModule.js';
import { AudioDecoderModule } from '../../../../../plugins/audio-decoder/engine/AudioDecoderModule.js';
import { AudioOutput302mModule } from '../../../../../plugins/audio-output-302m/engine/AudioOutput302mModule.js';
import { AsrcWatches } from '../../plugins/asrcWatches.js';

/**
 * The consumer strings gst_decode_asrc_chain_test.py runs (house-clock WI-P3-9 + WI-P3-15,
 * WI-P3-10), made by the real modules: `fixtures/decode-asrc/pipelines.json`, rewritten by
 * `vitest -u`. `@SOCK@` stands for the harness's socket directory. Modules are handled as plain
 * objects, as in alignerConformance.test.ts.
 */

const SOCK = '@SOCK@';
const FIXTURE = '../../../../../plugins/mpegts-core/tests/fixtures/decode-asrc/pipelines.json';

function source(name: string, port: number) {
    return {
        port,
        connectionId: `conn-${name}`,
        sourceModuleId: `mod-${name}`,
        sourcePortId: 'out',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `${SOCK}/${name}.sock`,
    };
}

type Built = { pipeline: string } | null;

/** aes67-output on one 302M edge, free-running RTP timestamps (no epoch claimed). */
function aes67(): string {
    const m = new Aes67OutputModule() as unknown as Record<string, unknown>;
    m.services = {
        instanceId: 'aes67',
        mediaRouter: { getModuleBusSource: () => source('in0', 40400) },
    };
    m.setHealth = vi.fn();
    const built = (m.buildPipeline as (c: unknown) => Built)({ address: '239.69.0.1', port: 5004 });
    expect(built).not.toBeNull();
    return built!.pipeline;
}

/** audio-output-302m with `n` sources at D = 300 ms: the single-source arm or the mixer arm. */
function audioOutput302m(n: number): string {
    const m = new AudioOutput302mModule() as unknown as Record<string, unknown>;
    const sources = Array.from({ length: n }, (_, i) => source(`in${i}`, 40410 + i));
    m.services = {
        instanceId: `aout${n}`,
        playoutOffsetMs: 300,
        mediaRouter: {
            getModuleBusSources: () => sources,
            getRoutePlayoutOffsetMs: () => undefined,
        },
    };
    m.setHealth = vi.fn();
    m.setStatusData = vi.fn();
    const built = (m.buildPipeline as (c: unknown) => Built)({ device: 'alsa_output.test' });
    expect(built).not.toBeNull();
    return built!.pipeline;
}

/** audio-decoder at D = 300 ms on one edge, its decoder branch picked by the probed `codec`. */
function audioDecoder(codec: string): string {
    const m = new AudioDecoderModule() as unknown as Record<string, unknown>;
    m.services = {
        instanceId: 'adec',
        playoutOffsetMs: 300,
        mediaRouter: {
            getModuleBusSource: () => source('in0', 40420),
            getRoutePlayoutOffsetMs: () => undefined,
        },
    };
    m.probeResult = { codec, rawCaps: '' };
    m.setHealth = vi.fn();
    const built = (m.buildPipeline as (c: unknown) => Built)({});
    expect(built).not.toBeNull();
    return built!.pipeline;
}

/** The decoder branches by the codec the probe reports ('unknown': decodebin). */
const DECODER_CODECS = ['opus', 'aac', 'mp2', 'ac3', 'unknown'] as const;

describe('the decode ASRC chains', () => {
    it('fixtures/decode-asrc/pipelines.json is what the modules make (`vitest -u` rewrites it)', async () => {
        const out: Record<string, string> = {
            aes67: aes67(),
            aout1: audioOutput302m(1),
            aout2: audioOutput302m(2),
        };
        for (const codec of DECODER_CODECS) out[`adec_${codec}`] = audioDecoder(codec);
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(FIXTURE);
    });

    it("the audio decoder's ASRC shows a clock correction and a device clock (WI-P3-6's reader)", () => {
        // Both terms are read off the string: `bypass-below-ppm` above 0, `device-sink` set.
        const w = new AsrcWatches();
        w.configure(audioDecoder('aac'));
        const stats = (mode: string, sourcePpb: number) => ({
            state: 'locked',
            relocks: 0,
            'in-frames': 96_000,
            mode,
            'source-ppb': sourcePpb,
            'device-ppb': -12_100,
        });
        w.take('mrasrc-stats', 'asrc', stats('device', 0), 0);
        expect(w.list()).toEqual([{ name: 'asrc', correction: {}, devicePpm: -12.1 }]);
        w.take('mrasrc-stats', 'asrc', stats('decode+device', 40_000), 2000);
        expect(w.list()).toEqual([
            { name: 'asrc', correction: { sourcePpm: 40 }, devicePpm: -12.1 },
        ]);
    });
});

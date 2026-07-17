import { describe, it, expect } from 'vitest';
import { buildPipeline } from './transcoderPipeline.js';
import {
    buildDynamicPorts,
    outputPortId,
    readRenditions,
    renditionLabel,
    type Rendition,
    type ResolvedEncode,
    type TranscoderOutput,
} from './transcoderPorts.js';
import { resolveImpl } from '@media-router/engine';

const r = (over: Partial<Rendition> = {}): Rendition => ({
    name: '',
    width: 1280,
    height: 720,
    bitrate: 2500,
    ...over,
});

/** Fully-resolved encode settings, as the module hands them to the pipeline. */
const enc = (over: Partial<ResolvedEncode> = {}): ResolvedEncode => ({
    codec: 'h264',
    impl: 'software',
    rateControl: 'cbr',
    speedPreset: 'ultrafast',
    h264Profile: 'auto',
    sceneCut: 40,
    ...over,
});

const out = (i: number, rendition: Rendition, encode: ResolvedEncode = enc()): TranscoderOutput => ({
    portId: outputPortId(i),
    host: '239.255.0.1',
    port: 41000 + i,
    rendition,
    encode,
});

describe('readRenditions', () => {
    it('coerces numeric fields and keeps the name', () => {
        const res = readRenditions({
            renditions: [{ name: 'HD', width: '1920', height: '1080', bitrate: '5000' }],
        });
        expect(res[0]).toMatchObject({ name: 'HD', width: 1920, height: 1080, bitrate: 5000 });
    });

    it('falls back to defaults for missing/invalid fields', () => {
        const res = readRenditions({ renditions: [{}, { width: -5, height: 0, bitrate: 'x' }] });
        expect(res[0]).toMatchObject({ name: '', width: 1280, height: 720, bitrate: 2500 });
        expect(res[1]).toMatchObject({ name: '', width: 1280, height: 720, bitrate: 2500 });
    });

    it('falls back to one provisional rendition when the key is absent (pre-start)', () => {
        // Empty/unconfigured config → one default rendition so a port shows on add.
        expect(readRenditions({})).toEqual([{ name: '720p', width: 1280, height: 720, bitrate: 2500 }]);
        expect(readRenditions({ renditions: 'nope' })).toHaveLength(1);
    });

    it('honours an explicit empty array as "no outputs"', () => {
        expect(readRenditions({ renditions: [] })).toEqual([]);
    });

    it('clamps to a maximum of 8 renditions', () => {
        const many = Array.from({ length: 20 }, () => ({ width: 100, height: 100, bitrate: 100 }));
        expect(readRenditions({ renditions: many })).toHaveLength(8);
    });

    it('leaves per-rendition overrides undefined (inherit) when absent', () => {
        const res = readRenditions({ renditions: [{ width: 640, height: 360, bitrate: 800 }] });
        expect(res[0]).toEqual({
            name: '',
            width: 640,
            height: 360,
            bitrate: 800,
            codec: undefined,
            encoderImpl: undefined,
            rateControl: undefined,
            speedPreset: undefined,
            h264Profile: undefined,
            sceneCut: undefined,
        });
    });

    it('parses valid per-rendition encoder overrides', () => {
        const res = readRenditions({
            renditions: [
                {
                    width: 1920,
                    height: 1080,
                    bitrate: 5000,
                    codec: 'h265',
                    encoderImpl: 'software',
                    rateControl: 'vbr',
                    speedPreset: 'medium',
                    h264Profile: 'high',
                    sceneCut: 0,
                },
            ],
        });
        expect(res[0]).toMatchObject({
            codec: 'h265',
            encoderImpl: 'software',
            rateControl: 'vbr',
            speedPreset: 'medium',
            h264Profile: 'high',
            sceneCut: 0,
        });
    });

    it('drops invalid override values back to inherit (undefined)', () => {
        const res = readRenditions({
            renditions: [
                {
                    width: 1280,
                    height: 720,
                    bitrate: 2500,
                    codec: 'vp9', // not a known codec
                    encoderImpl: 'nvenc', // not a known impl
                    rateControl: 'abr', // not cbr/vbr
                    speedPreset: 'warp', // not a known preset
                    h264Profile: 'ultra', // not a known profile
                },
            ],
        });
        expect(res[0].codec).toBeUndefined();
        expect(res[0].encoderImpl).toBeUndefined();
        expect(res[0].rateControl).toBeUndefined();
        expect(res[0].speedPreset).toBeUndefined();
        expect(res[0].h264Profile).toBeUndefined();
    });

    it('treats a blank sceneCut override as inherit and clamps a numeric one', () => {
        const blank = readRenditions({ renditions: [{ ...r(), sceneCut: '' }] });
        expect(blank[0].sceneCut).toBeUndefined();
        const clamped = readRenditions({ renditions: [{ ...r(), sceneCut: 250 }] });
        expect(clamped[0].sceneCut).toBe(100);
    });
});

describe('renditionLabel', () => {
    it('prefers the operator name, else WxH', () => {
        expect(renditionLabel(r({ name: ' Mobile ' }))).toBe('Mobile');
        expect(renditionLabel(r({ width: 854, height: 480 }))).toBe('854x480');
    });
});

describe('buildDynamicPorts', () => {
    it('always exposes one MPEG-TS input', () => {
        const ports = buildDynamicPorts([]);
        expect(ports).toHaveLength(1);
        expect(ports[0]).toMatchObject({ id: 'mpegts-in', direction: 'input', maxConnections: 1 });
    });

    it('adds one ordered-apply output per rendition with a label', () => {
        const ports = buildDynamicPorts([r({ name: '1080p' }), r({ width: 640, height: 360 })]);
        expect(ports).toHaveLength(3);
        expect(ports[1]).toMatchObject({
            id: 'out-0',
            direction: 'output',
            label: '1080p',
            maxConnections: -1,
            requiresOrderedApply: true,
        });
        expect(ports[2]).toMatchObject({ id: 'out-1', label: '640x360' });
    });
});

describe('buildPipeline', () => {
    const base = {
        input: { host: '239.0.0.1', port: 5004 },
        framerate: 50,
        gopFrames: 50,
    };

    it('returns null with no outputs', () => {
        expect(buildPipeline({ ...base, outputs: [] })).toBeNull();
    });

    it('decodes once into a single static pipeline that tees per rendition', () => {
        const outputs = [
            out(0, r({ width: 1920, height: 1080, bitrate: 5000 })),
            out(1, r({ width: 1280, height: 720, bitrate: 2500 })),
        ];
        const res = buildPipeline({ ...base, outputs })!;
        expect(res).not.toBeNull();

        const p = res.pipeline;
        // Single static pipeline (no linkOnPadAdded): udpsrc → tsparse → tsdemux
        // → decode once → conform framerate → tee → one leaf per rendition.
        expect(p).toContain('tsdemux latency=0');
        expect(p).toContain(`port=${base.input.port}`);
        expect(p.match(/avdec_h264/g)).toHaveLength(1); // decoded exactly once
        expect(p).toContain('framerate=50/1');
        expect(p).toContain('tee name=t');
        expect(p.match(/t\. !/g)).toHaveLength(2); // one tee branch per rendition

        // Per-rendition scale + bitrate + its own mux + udpsink.
        expect(p).toContain('video/x-raw,width=1920,height=1080');
        expect(p).toContain('video/x-raw,width=1280,height=720');
        expect(p).toContain('bitrate=5000');
        expect(p).toContain('bitrate=2500');
        expect(p).toContain('mux_0');
        expect(p).toContain('mux_1');
        expect(p).toContain('usink_0');
        expect(p).toContain('usink_1');
        expect(p).toContain('port=41000');
        expect(p).toContain('port=41001');

        // sinkNames is the single source of truth for the udpsink names the
        // module polls for throughput — one per rendition, in order.
        expect(res.sinkNames).toEqual(['usink_0', 'usink_1']);
    });

    it('filters tsdemux to video only so an audio pad cannot reach the decoder', () => {
        const res = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        // Capsfilter must sit directly on the tsdemux output (before any queue),
        // restricting to video codecs — otherwise an A/V source links its audio
        // pad into videoconvert and dies with "Internal data stream error".
        expect(res.pipeline).toMatch(/tsdemux latency=0 ! capsfilter caps="video\/x-h264"/);
    });

    it('passes the GOP frame count straight through as key-int-max', () => {
        const res = buildPipeline({ ...base, gopFrames: 60, outputs: [out(0, r())] })!;
        expect(res.pipeline).toContain('key-int-max=60');
    });

    it('applies each rendition\'s own rate control', () => {
        const cbr = buildPipeline({ ...base, outputs: [out(0, r(), enc({ rateControl: 'cbr' }))] })!;
        expect(cbr.pipeline).toContain('nal-hrd=cbr');
        const vbr = buildPipeline({ ...base, outputs: [out(0, r(), enc({ rateControl: 'vbr' }))] })!;
        expect(vbr.pipeline).not.toContain('nal-hrd=cbr');
        expect(vbr.pipeline).toContain('vbv-maxrate'); // VBV-capped VBR
    });

    it('applies each rendition\'s own speed preset', () => {
        const def = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(def.pipeline).toContain('speed-preset=ultrafast');
        const med = buildPipeline({ ...base, outputs: [out(0, r(), enc({ speedPreset: 'medium' }))] })!;
        expect(med.pipeline).toContain('speed-preset=medium');
        expect(med.pipeline).not.toContain('speed-preset=ultrafast');
    });

    it('forces the H.264 profile only when not "auto"', () => {
        const auto = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(auto.pipeline).not.toContain('profile=');
        const baseline = buildPipeline({
            ...base,
            outputs: [out(0, r(), enc({ h264Profile: 'baseline' }))],
        })!;
        expect(baseline.pipeline).toContain('video/x-h264,profile=baseline');
        expect(baseline.pipeline).toMatch(/profile=baseline ! h264parse/);
    });

    it('applies each rendition\'s own scenecut (incl. 0 = off)', () => {
        const def = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(def.pipeline).toContain('scenecut=40');
        const off = buildPipeline({ ...base, outputs: [out(0, r(), enc({ sceneCut: 0 }))] })!;
        expect(off.pipeline).toContain('scenecut=0');
    });

    it('emits codec-specific encoder elements', () => {
        const h265 = buildPipeline({ ...base, outputs: [out(0, r(), enc({ codec: 'h265' }))] })!;
        expect(h265.pipeline).toContain('x265enc');
    });

    it('builds an Intel VA-API hardware branch for H.265', () => {
        const res = buildPipeline({
            ...base,
            outputs: [out(0, r(), enc({ impl: 'va', codec: 'h265' }))],
        })!;
        expect(res.pipeline).toContain('vah265enc');
        expect(res.pipeline).toContain('rate-control=cbr');
        expect(res.pipeline).toMatch(/target-usage=\d/);
        expect(res.pipeline).not.toContain('x265enc');
    });

    it('mixes different codecs/presets across renditions in one pipeline', () => {
        const outputs = [
            out(0, r({ width: 1920, height: 1080, bitrate: 5000 }), enc({ speedPreset: 'medium' })),
            out(1, r({ width: 854, height: 480, bitrate: 1200 }), enc({ codec: 'h265' })),
        ];
        const p = buildPipeline({ ...base, outputs })!.pipeline;
        // Rendition 0 stays H.264 at its overridden preset; rendition 1 is H.265.
        expect(p).toContain('x264enc');
        expect(p).toContain('speed-preset=medium');
        expect(p).toContain('x265enc');
    });
});

describe('deinterlacing', () => {
    const base = {
        input: { host: '239.0.0.1', port: 5004 },
        framerate: 50,
        gopFrames: 50,
    };

    it('inserts an auto deinterlacer between the raw buffer and videorate by default', () => {
        const p = buildPipeline({ ...base, outputs: [out(0, r())] })!.pipeline;
        // mode=auto self-detects from decoded buffer flags: interlaced content is
        // deinterlaced, progressive passes through — the "auto by default" contract.
        expect(p).toMatch(/! deinterlace mode=auto ! videorate ! video\/x-raw,framerate=50\/1/);
    });

    it('force mode deinterlaces unconditionally', () => {
        const p = buildPipeline({ ...base, deinterlace: 'force', outputs: [out(0, r())] })!.pipeline;
        expect(p).toContain('deinterlace mode=interlaced ! videorate');
        expect(p).not.toContain('mode=auto');
    });

    it('off omits the deinterlacer entirely (interlaced pass-through)', () => {
        const p = buildPipeline({ ...base, deinterlace: 'off', outputs: [out(0, r())] })!.pipeline;
        expect(p).not.toContain('deinterlace');
    });

    it('off flags interlaced output on the software x264 branch only', () => {
        const sw = buildPipeline({ ...base, deinterlace: 'off', outputs: [out(0, r())] })!.pipeline;
        expect(sw).toMatch(/x264enc [^!]*interlaced=true/);
        // VA-API has no interlaced encode mode — flag must not leak there.
        const va = buildPipeline({
            ...base,
            deinterlace: 'off',
            outputs: [out(0, r(), enc({ impl: 'va' }))],
        })!.pipeline;
        expect(va).not.toContain('interlaced=true');
        // And deinterlaced modes never set it.
        const auto = buildPipeline({ ...base, outputs: [out(0, r())] })!.pipeline;
        expect(auto).not.toContain('interlaced=true');
    });
});

describe('hardware scaling', () => {
    const base = {
        input: { host: '239.0.0.1', port: 5004 },
        framerate: 50,
        gopFrames: 50,
    };

    it('va renditions scale on the GPU via vapostproc when available', () => {
        const p = buildPipeline({
            ...base,
            hwScalers: { va: true },
            outputs: [out(0, r(), enc({ impl: 'va' }))],
        })!.pipeline;
        expect(p).toContain('vapostproc ! video/x-raw(memory:VAMemory),width=1280,height=720');
        expect(p).not.toContain('videoscale');
        expect(p).not.toContain('videoconvert');
    });

    it('va renditions fall back to the software chain when vapostproc is absent', () => {
        const p = buildPipeline({
            ...base,
            outputs: [out(0, r(), enc({ impl: 'va' }))],
        })!.pipeline;
        expect(p).not.toContain('vapostproc');
        expect(p).toMatch(/videoscale ! video\/x-raw,width=1280,height=720 ! videoconvert/);
    });

    it('v4l2 renditions scale on the Pi ISP via v4l2convert when available', () => {
        const p = buildPipeline({
            ...base,
            hwScalers: { v4l2: true },
            outputs: [out(0, r(), enc({ impl: 'v4l2' }))],
        })!.pipeline;
        expect(p).toContain('v4l2convert ! video/x-raw,width=1280,height=720');
        expect(p).not.toContain('videoscale');
    });

    it('v4l2 renditions fall back to the software chain when v4l2convert is absent', () => {
        const p = buildPipeline({
            ...base,
            hwScalers: { va: true }, // va scaler present, v4l2 not
            outputs: [out(0, r(), enc({ impl: 'v4l2' }))],
        })!.pipeline;
        expect(p).not.toContain('v4l2convert');
        expect(p).toContain('videoscale');
    });

    it('mixes hardware and software scaling across renditions', () => {
        const p = buildPipeline({
            ...base,
            hwScalers: { va: true },
            outputs: [
                out(0, r({ width: 1920, height: 1080 }), enc({ impl: 'va' })),
                out(1, r({ width: 854, height: 480 })),
            ],
        })!.pipeline;
        expect(p).toContain('vapostproc ! video/x-raw(memory:VAMemory),width=1920,height=1080');
        expect(p).toMatch(/videoscale ! video\/x-raw,width=854,height=480 ! videoconvert/);
    });
});

describe('resolveImpl', () => {
    it('auto prefers v4l2, then software, then whatever remains', () => {
        expect(resolveImpl('h264', 'auto', ['software', 'va'])).toBe('software');
        expect(resolveImpl('h264', 'auto', ['va', 'software', 'v4l2'])).toBe('v4l2');
        // H.265 on an Intel box: VA-API is the only encoder → auto must pick it.
        expect(resolveImpl('h265', 'auto', ['va'])).toBe('va');
        expect(resolveImpl('h265', 'auto', [])).toBeNull();
    });

    it('honours an explicit impl when available', () => {
        expect(resolveImpl('h265', 'va', ['va'])).toBe('va');
    });
});

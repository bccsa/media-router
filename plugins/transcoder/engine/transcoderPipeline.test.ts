import { describe, it, expect } from 'vitest';
import {
    buildDynamicPorts,
    buildPipeline,
    outputPortId,
    readRenditions,
    renditionLabel,
    type Rendition,
    type TranscoderOutput,
} from './transcoderPipeline.js';
import { resolveImpl } from './encoderBranch.js';

const r = (over: Partial<Rendition> = {}): Rendition => ({
    name: '',
    width: 1280,
    height: 720,
    bitrate: 2500,
    ...over,
});

const out = (i: number, rendition: Rendition): TranscoderOutput => ({
    portId: outputPortId(i),
    host: '239.255.0.1',
    port: 41000 + i,
    rendition,
});

describe('readRenditions', () => {
    it('coerces numeric fields and keeps the name', () => {
        const res = readRenditions({
            renditions: [{ name: 'HD', width: '1920', height: '1080', bitrate: '5000' }],
        });
        expect(res).toEqual([{ name: 'HD', width: 1920, height: 1080, bitrate: 5000 }]);
    });

    it('falls back to defaults for missing/invalid fields', () => {
        const res = readRenditions({ renditions: [{}, { width: -5, height: 0, bitrate: 'x' }] });
        expect(res[0]).toEqual({ name: '', width: 1280, height: 720, bitrate: 2500 });
        expect(res[1]).toEqual({ name: '', width: 1280, height: 720, bitrate: 2500 });
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
});

describe('renditionLabel', () => {
    it('prefers the operator name, else WxH', () => {
        expect(renditionLabel(r({ name: ' Mobile ' }), 0)).toBe('Mobile');
        expect(renditionLabel(r({ width: 854, height: 480 }), 1)).toBe('854x480');
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
        codec: 'h264' as const,
        impl: 'software' as const,
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

    it('switches rate control between CBR and VBR', () => {
        const cbr = buildPipeline({ ...base, rateControl: 'cbr', outputs: [out(0, r())] })!;
        expect(cbr.pipeline).toContain('nal-hrd=cbr');
        const vbr = buildPipeline({ ...base, rateControl: 'vbr', outputs: [out(0, r())] })!;
        expect(vbr.pipeline).not.toContain('nal-hrd=cbr');
        expect(vbr.pipeline).toContain('vbv-maxrate'); // VBV-capped VBR
    });

    it('defaults to the ultrafast x264 preset and honours an override', () => {
        const def = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(def.pipeline).toContain('speed-preset=ultrafast');
        const med = buildPipeline({ ...base, speedPreset: 'medium', outputs: [out(0, r())] })!;
        expect(med.pipeline).toContain('speed-preset=medium');
        expect(med.pipeline).not.toContain('speed-preset=ultrafast');
    });

    it('forces the H.264 profile only when not "auto"', () => {
        const auto = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(auto.pipeline).not.toContain('profile=');
        const baseline = buildPipeline({ ...base, h264Profile: 'baseline', outputs: [out(0, r())] })!;
        expect(baseline.pipeline).toContain('video/x-h264,profile=baseline');
        expect(baseline.pipeline).toMatch(/profile=baseline ! h264parse/);
    });

    it('defaults scenecut to 40 and honours an override (incl. 0 = off)', () => {
        const def = buildPipeline({ ...base, outputs: [out(0, r())] })!;
        expect(def.pipeline).toContain('scenecut=40');
        const off = buildPipeline({ ...base, sceneCut: 0, outputs: [out(0, r())] })!;
        expect(off.pipeline).toContain('scenecut=0');
    });

    it('emits codec-specific encoder elements', () => {
        const h265 = buildPipeline({
            ...base,
            codec: 'h265',
            outputs: [out(0, r())],
        })!;
        expect(h265.pipeline).toContain('x265enc');
    });

    it('builds an Intel VA-API hardware branch for H.265', () => {
        const res = buildPipeline({ ...base, impl: 'va', codec: 'h265', outputs: [out(0, r())] })!;
        expect(res.pipeline).toContain('vah265enc');
        expect(res.pipeline).toContain('rate-control=cbr');
        expect(res.pipeline).toMatch(/target-usage=\d/);
        expect(res.pipeline).not.toContain('x265enc');
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

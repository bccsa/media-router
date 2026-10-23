import { describe, it, expect, vi } from 'vitest';

vi.mock('./gstInspect.js', async (orig) => ({
    ...(await orig<typeof import('./gstInspect.js')>()),
    probeGstElement: vi.fn(),
}));

import { GstInspectTimeoutError, probeGstElement } from './gstInspect.js';
import { ENCODER_ELEMENTS } from './encoderElements.js';
import { ProbedEncoders } from './probedEncoders.js';

const probeMock = probeGstElement as unknown as ReturnType<typeof vi.fn>;

describe('ProbedEncoders.forTest', () => {
    it('fills unnamed codecs with no impls — forTest({}) is the all-empty host', () => {
        const p = ProbedEncoders.forTest({});
        expect(p.availability).toEqual({ h264: [], h265: [], av1: [] });
        expect(p.hwScalers).toEqual({ va: false, v4l2: false });
    });

    it('keeps named availability and named scalers, defaults the rest', () => {
        const p = ProbedEncoders.forTest({ h264: ['v4l2', 'software'] }, { v4l2: true });
        expect(p.availability.h264).toEqual(['v4l2', 'software']);
        expect(p.availability.h265).toEqual([]);
        expect(p.hwScalers).toEqual({ va: false, v4l2: true });
    });
});

describe('ProbedEncoders.resolve', () => {
    const p = ProbedEncoders.forTest({ h264: ['v4l2', 'software'], h265: ['software'] });

    it("'auto' and undefined pick the first available impl", () => {
        expect(p.resolve('h264', 'auto')).toBe('v4l2');
        expect(p.resolve('h264', undefined)).toBe('v4l2');
    });

    it('an explicit installed impl is honoured', () => {
        expect(p.resolve('h264', 'software')).toBe('software');
    });

    it('an explicit impl that is not installed falls back to the first available', () => {
        expect(p.resolve('h265', 'v4l2')).toBe('software');
    });

    it('a codec with no impls resolves to null', () => {
        expect(p.resolve('av1', 'auto')).toBeNull();
        expect(ProbedEncoders.forTest({}).resolve('h264', 'auto')).toBeNull();
    });
});

describe('ProbedEncoders.applyToManifest', () => {
    it('narrows the codec enum and builds the per-codec impl map', () => {
        const p = ProbedEncoders.forTest({ h264: ['software'] });
        const manifest: Record<string, any> = {
            configSchema: {
                properties: {
                    codec: { enum: ['h264', 'h265', 'av1'] },
                    encoderImpl: { enum: ['auto', 'v4l2', 'va', 'software'] },
                },
            },
        };
        p.applyToManifest(manifest);
        expect(manifest.configSchema.properties.codec.enum).toEqual(['h264']);
        expect(manifest.configSchema.properties.encoderImpl['x-enumBy'].map.h264).toEqual([
            'auto',
            'software',
        ]);
    });
});

describe('ProbedEncoders.probe', () => {
    it('a probe that timed out, a scaler too, rejects instead of reading as not installed (B-102)', async () => {
        probeMock.mockImplementation(async (name: string) => {
            if (name === 'v4l2convert') throw new GstInspectTimeoutError([name]);
            return name === 'x264enc';
        });
        await expect(
            ProbedEncoders.probe(ENCODER_ELEMENTS, { probeHwScalers: true }),
        ).rejects.toThrow('gst-inspect-1.0 v4l2convert timed out after 30 s');

        probeMock.mockImplementation(
            async (name: string) => name === 'x264enc' || name === 'v4l2convert',
        );
        const host = await ProbedEncoders.probe(ENCODER_ELEMENTS, { probeHwScalers: true });
        expect(host.availability).toEqual({ h264: ['software'], h265: [], av1: [] });
        expect(host.hwScalers).toEqual({ va: false, v4l2: true });
    });
});

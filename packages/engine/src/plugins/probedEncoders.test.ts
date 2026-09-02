import { describe, it, expect } from 'vitest';
import { ProbedEncoders } from './probedEncoders.js';

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

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gstInspect.js', () => ({ probeGstElement: vi.fn() }));

import { probeGstElement } from './gstInspect.js';
import {
    probeEncoderAvailability,
    applyEncoderAvailabilityToManifest,
} from './encoderManifest.js';
import { ENCODER_ELEMENTS } from './encoderElements.js';

const probeMock = probeGstElement as unknown as ReturnType<typeof vi.fn>;

function setProbe(available: Record<string, boolean>) {
    probeMock.mockImplementation(async (name: string) => !!available[name]);
}

describe('probeEncoderAvailability', () => {
    beforeEach(() => probeMock.mockReset());

    it('lists the installed impls per codec, in element-table order', async () => {
        setProbe({
            v4l2h264enc: true,
            x264enc: true,
            v4l2h265enc: false,
            x265enc: true,
            vah265enc: false,
            svtav1enc: false,
        });
        const availability = await probeEncoderAvailability(ENCODER_ELEMENTS);
        expect(availability).toEqual({
            h264: ['v4l2', 'software'],
            h265: ['software'],
            av1: [],
        });
    });

    it('includes VA-API when its elements probe true', async () => {
        setProbe({ vah264enc: true, vah265enc: true, vaav1enc: true });
        const availability = await probeEncoderAvailability(ENCODER_ELEMENTS);
        expect(availability).toEqual({ h264: ['va'], h265: ['va'], av1: ['va'] });
    });

    it('returns all-empty when nothing is installed', async () => {
        setProbe({});
        const availability = await probeEncoderAvailability(ENCODER_ELEMENTS);
        expect(availability).toEqual({ h264: [], h265: [], av1: [] });
    });
});

describe('applyEncoderAvailabilityToManifest', () => {
    it('narrows the codec enum and builds the encoderImpl x-enumBy map', () => {
        const manifest = {
            configSchema: {
                properties: {
                    codec: { enum: ['h264', 'h265', 'av1'] },
                    encoderImpl: { enum: ['auto', 'v4l2', 'va', 'software'] },
                },
            },
        };
        applyEncoderAvailabilityToManifest(manifest, {
            h264: ['v4l2', 'software'],
            h265: ['va'],
            av1: [],
        });
        expect(manifest.configSchema.properties.codec.enum).toEqual(['h264', 'h265']);
        expect((manifest.configSchema.properties.encoderImpl as any)['x-enumBy']).toEqual({
            field: 'codec',
            map: {
                h264: ['auto', 'v4l2', 'software'],
                h265: ['auto', 'va'],
                av1: ['auto'],
            },
        });
    });

    it('leaves the codec enum untouched when no codec has an encoder', () => {
        const manifest = {
            configSchema: { properties: { codec: { enum: ['h264'] } } },
        };
        applyEncoderAvailabilityToManifest(manifest, { h264: [], h265: [], av1: [] });
        expect(manifest.configSchema.properties.codec.enum).toEqual(['h264']);
    });

    it('is a no-op when the schema has no properties', () => {
        const manifest = { configSchema: {} };
        expect(() =>
            applyEncoderAvailabilityToManifest(manifest, { h264: ['software'], h265: [], av1: [] }),
        ).not.toThrow();
    });

    it('keeps auto in an encoderImpl x-showWhen when auto resolves to a listed impl', () => {
        // x86 box: no v4l2, x264 installed → auto resolves to software, so the
        // software-only field stays visible under auto.
        const manifest = {
            configSchema: {
                properties: {
                    sceneCut: { 'x-showWhen': 'encoderImpl=software,auto' },
                    speedPreset: { 'x-showWhen': 'encoderImpl=software,va,auto' },
                },
            },
        };
        applyEncoderAvailabilityToManifest(manifest, {
            h264: ['va', 'software'],
            h265: ['software'],
            av1: [],
        });
        const props = manifest.configSchema.properties as any;
        expect(props.sceneCut['x-showWhen']).toBe('encoderImpl=software,auto');
        expect(props.speedPreset['x-showWhen']).toBe('encoderImpl=software,va,auto');
    });

    it('removes auto from an encoderImpl x-showWhen when auto resolves elsewhere', () => {
        // Pi: v4l2 present → auto resolves to v4l2, which ignores the software
        // knobs — auto is dropped so the fields hide under auto.
        const manifest = {
            configSchema: {
                properties: {
                    sceneCut: { 'x-showWhen': 'encoderImpl=software,auto' },
                    other: { 'x-showWhen': 'codec=h264' },
                },
            },
        };
        applyEncoderAvailabilityToManifest(manifest, {
            h264: ['v4l2', 'software'],
            h265: ['v4l2'],
            av1: [],
        });
        const props = manifest.configSchema.properties as any;
        expect(props.sceneCut['x-showWhen']).toBe('encoderImpl=software');
        // non-encoderImpl rules are left alone
        expect(props.other['x-showWhen']).toBe('codec=h264');
    });
});

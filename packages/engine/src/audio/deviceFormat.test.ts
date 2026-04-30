import { describe, it, expect } from 'vitest';
import {
    detectDeviceFormat,
    resolveDeviceFormat,
    tryResolveDeviceFormat,
} from './deviceFormat.js';
import type { PipeWireManager } from './PipeWireManager.js';

function fakePipeWire(
    devices: Record<string, { channels?: number; sampleRate?: number } | null>,
): PipeWireManager {
    return {
        getDeviceInfo(name: string) {
            return name in devices ? devices[name] : null;
        },
    } as unknown as PipeWireManager;
}

describe('detectDeviceFormat', () => {
    it('returns empty detection when pipewire is missing', () => {
        const r = detectDeviceFormat(undefined, 'foo', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.configUpdates).toEqual({});
        expect(r.healthWarning).toBeNull();
    });

    it('returns empty detection when device name is empty', () => {
        const r = detectDeviceFormat(fakePipeWire({}), '', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.healthWarning).toBeNull();
    });

    it('returns a "device not found" warning when pipewire does not enumerate the device', () => {
        const pw = fakePipeWire({});
        const r = detectDeviceFormat(pw, 'missing-mic', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.healthWarning).toMatch(/missing-mic.*not found/);
    });

    it('emits configUpdates for both fields when probed values differ from saved config', () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 44100 } });
        const r = detectDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 });
        expect(r.detected).toEqual({ channels: 1, sampleRate: 44100 });
        expect(r.configUpdates).toEqual({ channels: 1, sampleRate: 44100 });
        expect(r.healthWarning).toBeNull();
    });

    it('emits no configUpdates when probe matches saved config', () => {
        const pw = fakePipeWire({ mic: { channels: 2, sampleRate: 48000 } });
        const r = detectDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 });
        expect(r.configUpdates).toEqual({});
    });

    it('warns about a suspended device when channels are undefined but sample rate is known', () => {
        const pw = fakePipeWire({ mic: { sampleRate: 48000 } });
        const r = detectDeviceFormat(pw, 'mic', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: 48000 });
        expect(r.healthWarning).toMatch(/suspended/);
    });

    it('drops zero-valued probe fields rather than persisting bogus updates', () => {
        const pw = fakePipeWire({ mic: { channels: 0, sampleRate: 0 } });
        const r = detectDeviceFormat(pw, 'mic', {});
        expect(r.configUpdates).toEqual({});
    });
});

describe('tryResolveDeviceFormat', () => {
    it('uses the live probe when present', () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 44100 } });
        const r = tryResolveDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 }, {});
        expect(r.channels).toBe(1);
        expect(r.rate).toBe(44100);
        expect(r.detected).toEqual({ channels: 1, sampleRate: 44100 });
    });

    it('falls back to prior detected state when the probe goes silent', () => {
        const pw = fakePipeWire({});
        const r = tryResolveDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 }, {});
        expect(r.channels).toBe(2);
        expect(r.rate).toBe(48000);
    });

    it('falls through to the persisted config when probe and prior are both empty', () => {
        const pw = fakePipeWire({});
        const r = tryResolveDeviceFormat(
            pw,
            'mic',
            { channels: null, sampleRate: null },
            { channels: 6, sampleRate: 96000 },
        );
        expect(r.channels).toBe(6);
        expect(r.rate).toBe(96000);
    });

    it('returns null when nothing supplies a channel count', () => {
        const r = tryResolveDeviceFormat(
            undefined,
            'mic',
            { channels: null, sampleRate: 48000 },
            {},
        );
        expect(r.channels).toBeNull();
        expect(r.rate).toBe(48000);
    });

    it('rejects zero/negative as not-a-real-channel-count', () => {
        const pw = fakePipeWire({ mic: { channels: 0, sampleRate: 0 } });
        const r = tryResolveDeviceFormat(pw, 'mic', { channels: null, sampleRate: null }, {});
        expect(r.channels).toBeNull();
        expect(r.rate).toBeNull();
    });
});

describe('resolveDeviceFormat', () => {
    it('returns the resolved pair when everything is known', () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 48000 } });
        const r = resolveDeviceFormat(
            pw,
            'mic',
            { channels: null, sampleRate: null },
            {},
            'input',
        );
        expect(r).toEqual({
            channels: 1,
            rate: 48000,
            detected: { channels: 1, sampleRate: 48000 },
        });
    });

    it('throws on missing channel count with an input-specific suspension hint', () => {
        const pw = fakePipeWire({});
        expect(() =>
            resolveDeviceFormat(
                pw,
                'mic',
                { channels: null, sampleRate: 48000 },
                { sampleRate: 48000 },
                'input',
            ),
        ).toThrow(/channel count is unknown.*suspended/);
    });

    it('throws without the suspension hint on outputs (the suspend race only matters for capture)', () => {
        const pw = fakePipeWire({});
        expect(() =>
            resolveDeviceFormat(
                pw,
                'speaker',
                { channels: null, sampleRate: 48000 },
                { sampleRate: 48000 },
                'output',
            ),
        ).toThrow(/channel count is unknown\.$/);
    });

    it('throws on missing sample rate even when channels are known', () => {
        const pw = fakePipeWire({});
        expect(() =>
            resolveDeviceFormat(
                pw,
                'mic',
                { channels: 2, sampleRate: null },
                { channels: 2 },
                'input',
            ),
        ).toThrow(/sample rate is unknown/);
    });
});

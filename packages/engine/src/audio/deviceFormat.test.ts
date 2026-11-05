import { describe, it, expect } from 'vitest';
import { detectDeviceFormat, resolveDeviceFormat, tryResolveDeviceFormat } from './deviceFormat.js';
import type { PipeWireManager } from './PipeWireManager.js';

/** `answers` false: PipeWire gives no answer, so every device is unknown (B-207). */
function fakePipeWire(
    devices: Record<string, { channels?: number; sampleRate?: number } | null>,
    answers = true,
): PipeWireManager {
    return {
        async getDeviceInfo(name: string) {
            return answers && name in devices ? devices[name] : null;
        },
        async hasDevice(name: string) {
            return answers ? name in devices : null;
        },
    } as unknown as PipeWireManager;
}

describe('detectDeviceFormat', () => {
    it('returns empty detection when pipewire is missing', async () => {
        const r = await detectDeviceFormat(undefined, 'foo', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.configUpdates).toEqual({});
        expect(r.healthWarning).toBeNull();
    });

    it('returns empty detection when device name is empty', async () => {
        const r = await detectDeviceFormat(fakePipeWire({}), '', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.healthWarning).toBeNull();
    });

    it('returns a "device not found" warning when pipewire does not enumerate the device', async () => {
        const pw = fakePipeWire({});
        const r = await detectDeviceFormat(pw, 'missing-mic', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: null });
        expect(r.healthWarning).toMatch(/missing-mic.*not found/);
    });

    it('no answer from PipeWire: no detection and no "not found", the device is unknown (B-207)', async () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 48000 } }, false);
        const r = await detectDeviceFormat(pw, 'mic', { channels: 2 });
        expect(r).toEqual({
            detected: { channels: null, sampleRate: null },
            configUpdates: {},
            healthWarning: null,
        });
    });

    it('emits configUpdates for both fields when probed values differ from saved config', async () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 44100 } });
        const r = await detectDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 });
        expect(r.detected).toEqual({ channels: 1, sampleRate: 44100 });
        expect(r.configUpdates).toEqual({ channels: 1, sampleRate: 44100 });
        expect(r.healthWarning).toBeNull();
    });

    it('emits no configUpdates when probe matches saved config', async () => {
        const pw = fakePipeWire({ mic: { channels: 2, sampleRate: 48000 } });
        const r = await detectDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 });
        expect(r.configUpdates).toEqual({});
    });

    it('warns about a suspended device when channels are undefined but sample rate is known', async () => {
        const pw = fakePipeWire({ mic: { sampleRate: 48000 } });
        const r = await detectDeviceFormat(pw, 'mic', {});
        expect(r.detected).toEqual({ channels: null, sampleRate: 48000 });
        expect(r.healthWarning).toMatch(/suspended/);
    });

    it('drops zero-valued probe fields rather than persisting bogus updates', async () => {
        const pw = fakePipeWire({ mic: { channels: 0, sampleRate: 0 } });
        const r = await detectDeviceFormat(pw, 'mic', {});
        expect(r.configUpdates).toEqual({});
    });
});

describe('tryResolveDeviceFormat', () => {
    it('uses the live probe when present', async () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 44100 } });
        const r = await tryResolveDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 }, {});
        expect(r.channels).toBe(1);
        expect(r.rate).toBe(44100);
        expect(r.detected).toEqual({ channels: 1, sampleRate: 44100 });
    });

    it('falls back to prior detected state when the probe goes silent', async () => {
        const pw = fakePipeWire({});
        const r = await tryResolveDeviceFormat(pw, 'mic', { channels: 2, sampleRate: 48000 }, {});
        expect(r.channels).toBe(2);
        expect(r.rate).toBe(48000);
    });

    it('falls through to the persisted config when probe and prior are both empty', async () => {
        const pw = fakePipeWire({});
        const r = await tryResolveDeviceFormat(
            pw,
            'mic',
            { channels: null, sampleRate: null },
            { channels: 6, sampleRate: 96000 },
        );
        expect(r.channels).toBe(6);
        expect(r.rate).toBe(96000);
    });

    it('returns null when nothing supplies a channel count', async () => {
        const r = await tryResolveDeviceFormat(
            undefined,
            'mic',
            { channels: null, sampleRate: 48000 },
            {},
        );
        expect(r.channels).toBeNull();
        expect(r.rate).toBe(48000);
    });

    it('rejects zero/negative as not-a-real-channel-count', async () => {
        const pw = fakePipeWire({ mic: { channels: 0, sampleRate: 0 } });
        const r = await tryResolveDeviceFormat(pw, 'mic', { channels: null, sampleRate: null }, {});
        expect(r.channels).toBeNull();
        expect(r.rate).toBeNull();
    });
});

describe('resolveDeviceFormat', () => {
    it('returns the resolved pair when everything is known', async () => {
        const pw = fakePipeWire({ mic: { channels: 1, sampleRate: 48000 } });
        const r = await resolveDeviceFormat(
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

    it('throws on missing channel count with an input-specific suspension hint', async () => {
        const pw = fakePipeWire({});
        await expect(
            resolveDeviceFormat(
                pw,
                'mic',
                { channels: null, sampleRate: 48000 },
                { sampleRate: 48000 },
                'input',
            ),
        ).rejects.toThrow(/channel count is unknown.*suspended/);
    });

    it('throws without the suspension hint on outputs (the suspend race only matters for capture)', async () => {
        const pw = fakePipeWire({});
        await expect(
            resolveDeviceFormat(
                pw,
                'speaker',
                { channels: null, sampleRate: 48000 },
                { sampleRate: 48000 },
                'output',
            ),
        ).rejects.toThrow(/channel count is unknown\.$/);
    });

    it('throws on missing sample rate even when channels are known', async () => {
        const pw = fakePipeWire({});
        await expect(
            resolveDeviceFormat(
                pw,
                'mic',
                { channels: 2, sampleRate: null },
                { channels: 2 },
                'input',
            ),
        ).rejects.toThrow(/sample rate is unknown/);
    });
});

import { describe, expect, it } from 'vitest';
import { encoderStatus, throughputStatus } from './videoEncoderStatus.js';

describe('encoderStatus', () => {
    it('reports the resolved impl and configured knobs', () => {
        expect(
            encoderStatus(
                { codec: 'h264', resolution: '1280x720', framerate: 25, bitrate: 6928 },
                'v4l2',
            ),
        ).toEqual({
            codec: 'h264',
            impl: 'v4l2',
            resolution: '1280x720',
            framerate: '25 fps',
            bitrate: 6928,
        });
    });
    it('says "unavailable" when no impl resolved, with defaults for an empty config', () => {
        expect(encoderStatus({}, null)).toEqual({
            codec: 'h264',
            impl: 'unavailable',
            resolution: '1920x1080',
            framerate: '30 fps',
            bitrate: 4000,
        });
    });
});

describe('throughputStatus', () => {
    it('formats kbps and MB', () => {
        expect(
            throughputStatus({
                bitrateKbps: 6912,
                totalBytes: 15 * 1024 * 1024,
                intervalMs: 1000,
            } as any),
        ).toEqual({
            'Output Bitrate': '6912 kbps',
            'Total Bytes': '15.0 MB',
        });
    });
});

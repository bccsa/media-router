import { describe, it, expect } from 'vitest';
import { buildRelayPipeline } from './MjpegRelayModule.js';

describe('buildRelayPipeline', () => {
    it('relays MJPG untouched: no jpegparse, no decoder, no encoder', () => {
        const p = buildRelayPipeline('/dev/video0', 1920, 1080, 50, '10.9.16.105', 5008);
        expect(p).toBe(
            'v4l2src device=/dev/video0 ! image/jpeg,width=1920,height=1080,framerate=50/1 ' +
                '! rtpjpegpay ! udpsink host=10.9.16.105 port=5008 sync=false',
        );
        expect(p).not.toContain('jpegparse');
        expect(p).not.toContain('jpegdec');
        expect(p).not.toContain('enc');
    });
});

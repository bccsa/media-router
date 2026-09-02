import { describe, it, expect } from 'vitest';
import { buildMonitorPipeline } from './MjpegMonitorModule.js';

describe('buildMonitorPipeline', () => {
    it('presents on arrival: sync=false, no jitter buffer, no queue', () => {
        const p = buildMonitorPipeline(5008, true);
        expect(p).toContain('udpsrc port=5008');
        expect(p).toContain(
            'rtpjpegdepay ! jpegdec ! videoconvert ! waylandsink sync=false fullscreen=true',
        );
        expect(p).not.toContain('queue');
        expect(p).not.toContain('jitterbuffer');
    });

    it('windowed mode drops the fullscreen flag', () => {
        expect(buildMonitorPipeline(6000, false).endsWith('waylandsink sync=false')).toBe(true);
    });
});

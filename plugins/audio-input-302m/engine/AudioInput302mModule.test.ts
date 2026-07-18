import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioInput302mModule } from './AudioInput302mModule.js';

function makeModule(opts: { udpPort?: number | null } = {}) {
    const module = new AudioInput302mModule() as any;
    module.services = {
        instanceId: 'ain-1',
        mediaRouter: {
            assignUdpPort: vi.fn(() =>
                opts.udpPort === null ? null : { host: '239.255.0.1', port: 41000 },
            ),
        },
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioInput302mModule.buildPipeline', () => {
    it('never captures a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
    });

    it('captures the explicit device into a 302M encode tail', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic', volume: 100 });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('pulsesrc device=alsa_input.usb-mic buffer-time=60000');
        expect(desc!.pipeline).toContain('volume name=vol volume=1.00');
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain(
            'audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7',
        );
        expect(desc!.restartOnError).toBe(true);
    });

    it('clamps srcBufferMs to the 40ms floor', () => {
        const { module } = makeModule();
        const desc = module.buildPipeline({ device: 'alsa_input.usb-mic', srcBufferMs: 5 });
        expect(desc!.pipeline).toContain('buffer-time=40000');
    });

    it('health error when the UDP port pool is exhausted', () => {
        const { module, setHealth } = makeModule({ udpPort: null });
        expect(module.buildPipeline({ device: 'alsa_input.usb-mic' })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No free UDP'));
    });
});

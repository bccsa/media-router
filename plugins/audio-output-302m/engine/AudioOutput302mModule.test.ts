import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

function makeModule(opts: { sources?: number } = {}) {
    const module = new AudioOutput302mModule() as any;
    const sources = Array.from({ length: opts.sources ?? 0 }, (_, i) => ({
        host: '239.255.0.1',
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
    }));
    module.services = {
        instanceId: 'aout-1',
        mediaRouter: { getModuleUdpSources: vi.fn(() => sources) },
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    return { module, setHealth };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioOutput302mModule.buildPipeline', () => {
    it('never plays to a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule({ sources: 1 });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
    });

    it('returns null + warning with no 302M sources', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No 302M'));
    });

    it('mixes N sources and plays to the EXPLICIT device with volume + VU in-pipeline', () => {
        const { module } = makeModule({ sources: 2 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', volume: 80 });
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('audiomixer name=mixin force-live=true');
        expect(desc!.pipeline.match(/! mixin\./g)).toHaveLength(2);
        expect(desc!.pipeline).toContain('volume name=vol volume=0.80');
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain('pulsesink device=alsa_output.usb-foo sync=false');
        expect(desc!.restartOnError).toBe(true);
    });

    it('mutes via the gst volume element when audioEnabled=false', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            volume: 90,
            audioEnabled: false,
        });
        expect(desc!.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('consumes the per-connection unixfd edge sockets under unixfd transport', () => {
        vi.stubEnv('MR_BUS_TRANSPORT', 'unixfd');
        try {
            const { module } = makeModule({ sources: 1 });
            const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
            expect(desc!.pipeline).toContain('socket-path=/tmp/mr-bus-40100-x.sock');
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

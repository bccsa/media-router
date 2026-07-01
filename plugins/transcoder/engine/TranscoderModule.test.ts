import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscoderModule } from './TranscoderModule.js';

function makeModule(opts: { upstream?: { host: string; port: number } | undefined } = {}) {
    const module = new TranscoderModule();
    const getModuleUdpSource = vi.fn(() =>
        'upstream' in opts ? opts.upstream : { host: '239.0.0.1', port: 5004 },
    );
    let nextPort = 41000;
    const assignUdpPort = vi.fn((_id: string, _portId?: string) => ({
        host: '239.255.0.1',
        port: nextPort++,
    }));
    (module as any).services = {
        instanceId: 'tc-1',
        mediaRouter: { getModuleUdpSource, assignUdpPort },
    };
    (module as any).setHealth = vi.fn();
    (module as any).setStatusData = vi.fn();
    return { module, getModuleUdpSource, assignUdpPort };
}

beforeEach(() => {
    TranscoderModule.setAvailableImpls({ h264: ['software'], h265: ['software'], av1: ['software'] });
});

describe('getDynamicPorts', () => {
    it('one input + one output per configured rendition', () => {
        const { module } = makeModule();
        (module as any).config = {
            renditions: [
                { name: '1080p', width: 1920, height: 1080, bitrate: 5000 },
                { name: '720p', width: 1280, height: 720, bitrate: 2500 },
            ],
        };
        const ports = module.getDynamicPorts();
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'out-0', 'out-1']);
        expect(ports[1].label).toBe('1080p');
    });

    it('input + one provisional output for empty (pre-start) config', () => {
        // The engine resolves ports before onInit populates config; a provisional
        // output keeps the node from rendering with no outputs at all.
        const { module } = makeModule();
        (module as any).config = {};
        const ports = module.getDynamicPorts();
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'out-0']);
    });

    it('input only when renditions is an explicit empty array', () => {
        const { module } = makeModule();
        (module as any).config = { renditions: [] };
        const ports = module.getDynamicPorts();
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in']);
    });
});

describe('buildPipeline', () => {
    it('warns and returns null with no upstream source', () => {
        const { module } = makeModule({ upstream: undefined });
        (module as any).config = { renditions: [{ width: 1280, height: 720, bitrate: 2500 }] };
        expect(module.buildPipeline((module as any).config)).toBeNull();
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No upstream'),
        );
    });

    it('warns and returns null with no renditions', () => {
        const { module } = makeModule();
        (module as any).config = { renditions: [] };
        expect(module.buildPipeline((module as any).config)).toBeNull();
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('No renditions'),
        );
    });

    it('errors when no encoder impl is available for the codec', () => {
        TranscoderModule.setAvailableImpls({ h264: [], h265: [], av1: [] });
        const { module } = makeModule();
        (module as any).config = { codec: 'h264', renditions: [{ width: 1280, height: 720, bitrate: 2500 }] };
        expect(module.buildPipeline((module as any).config)).toBeNull();
        expect((module as any).setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No encoder'));
    });

    it('allocates a distinct UDP port per rendition and builds the pipeline', () => {
        const { module, assignUdpPort } = makeModule();
        (module as any).config = {
            codec: 'h264',
            framerate: 50,
            gopFrames: 50,
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000 },
                { width: 1280, height: 720, bitrate: 2500 },
            ],
        };
        const desc = module.buildPipeline((module as any).config)!;
        expect(desc).not.toBeNull();
        expect(assignUdpPort).toHaveBeenCalledWith('tc-1', 'out-0');
        expect(assignUdpPort).toHaveBeenCalledWith('tc-1', 'out-1');
        expect(desc.restartOnError).toBe(true);
        expect(desc.pipeline).toContain('tee name=t');
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'h264', impl: 'software' }),
        );
    });
});

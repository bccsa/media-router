import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bitrateBadge } from '@media-router/engine';
import { TranscoderModule } from './TranscoderModule.js';

function makeModule(opts: { upstream?: { port: number; socketPath: string } | undefined } = {}) {
    const module = new TranscoderModule();
    const getModuleBusSource = vi.fn(() =>
        'upstream' in opts
            ? opts.upstream
            : { port: 5004, socketPath: '/tmp/mr-bus-5004-abc123.sock' },
    );
    let nextPort = 41000;
    const assignBusChannel = vi.fn((_id: string, _portId?: string) => ({
        port: nextPort++,
    }));
    (module as any).services = {
        instanceId: 'tc-1',
        mediaRouter: { getModuleBusSource, assignBusChannel },
    };
    (module as any).setHealth = vi.fn();
    (module as any).setStatusData = vi.fn();
    (module as any).setBadge = vi.fn();
    return { module, getModuleBusSource, assignBusChannel };
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
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('No h264 encoder available'),
        );
    });

    it('allocates a distinct UDP port per rendition and builds the pipeline', () => {
        const { module, assignBusChannel } = makeModule();
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
        expect(assignBusChannel).toHaveBeenCalledWith('tc-1', 'out-0');
        expect(assignBusChannel).toHaveBeenCalledWith('tc-1', 'out-1');
        expect(desc.restartOnError).toBe(true);
        expect(desc.pipeline).toContain('tee name=t');
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'h264', impl: 'software' }),
        );
    });

    it('exposes per-rendition target bitrates in the encoder stats', () => {
        const { module } = makeModule();
        module.buildPipeline({
            renditions: [
                { width: 1280, height: 720, bitrate: 2500 },
                { width: 640, height: 360, bitrate: 800 },
            ],
        });
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ renditions: '1280x720@2500k, 640x360@800k' }),
        );
    });

    it('applies a per-rendition override on top of the global default', () => {
        TranscoderModule.setAvailableImpls({ h264: ['software'], h265: ['software'], av1: [] });
        const { module } = makeModule();
        // Global codec is h264; only the second rendition overrides to h265.
        const desc = module.buildPipeline({
            codec: 'h264',
            speedPreset: 'ultrafast',
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000, speedPreset: 'medium' },
                { width: 854, height: 480, bitrate: 1200, codec: 'h265' },
            ],
        })!;
        expect(desc.pipeline).toContain('x264enc'); // rendition 0 inherits global codec
        expect(desc.pipeline).toContain('speed-preset=medium'); // rendition 0 override
        expect(desc.pipeline).toContain('x265enc'); // rendition 1 codec override
    });

    it('flags overridden knobs in the encoder status summary', () => {
        const { module } = makeModule();
        module.buildPipeline({
            codec: 'h264',
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000 },
                { width: 854, height: 480, bitrate: 1200, codec: 'h265', speedPreset: 'medium' },
            ],
        });
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ renditions: '1920x1080@5000k, 854x480@1200k [h265, medium]' }),
        );
    });

    it('reports the shared codec/impl in the headline, else "mixed"', () => {
        const { module } = makeModule();
        // Uniform: both renditions inherit h264/software.
        module.buildPipeline({
            codec: 'h264',
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000 },
                { width: 854, height: 480, bitrate: 1200 },
            ],
        });
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'h264', impl: 'software' }),
        );
        // One rendition overrides the codec → headline collapses to 'mixed'.
        module.buildPipeline({
            codec: 'h264',
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000 },
                { width: 854, height: 480, bitrate: 1200, codec: 'h265' },
            ],
        });
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'mixed', impl: 'software' }),
        );
    });

    it('never names the unused global codec when every rendition overrides', () => {
        // Global codec av1 has NO encoder, but both renditions override to h264.
        TranscoderModule.setAvailableImpls({ h264: ['software'], h265: ['software'], av1: [] });
        const { module } = makeModule();
        const desc = module.buildPipeline({
            codec: 'av1',
            renditions: [
                { width: 1920, height: 1080, bitrate: 5000, codec: 'h264' },
                { width: 854, height: 480, bitrate: 1200, codec: 'h264' },
            ],
        });
        expect(desc).not.toBeNull();
        expect((module as any).setStatusData).toHaveBeenCalledWith(
            'encoder',
            expect.objectContaining({ codec: 'h264', impl: 'software' }),
        );
    });

    it('errors naming the rendition when its overridden codec has no encoder', () => {
        // av1 has no impl available; a rendition overriding to av1 must fail clearly.
        TranscoderModule.setAvailableImpls({ h264: ['software'], h265: ['software'], av1: [] });
        const { module } = makeModule();
        expect(
            module.buildPipeline({
                codec: 'h264',
                renditions: [{ name: 'HiQ', width: 1920, height: 1080, bitrate: 5000, codec: 'av1' }],
            }),
        ).toBeNull();
        expect((module as any).setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('No av1 encoder available for rendition "HiQ"'),
        );
    });
});

describe('TranscoderModule throughput (multi-counter ThroughputPoller)', () => {
    afterEach(() => vi.useRealTimers());

    function setup() {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(10_000));
        const module = makeModule().module as any;
        module.running = true;
        module.sinkNames = ['busout_41000', 'busout_41001'];
        module.renditions = [
            { width: 1280, height: 720, bitrate: 2500 },
            { width: 640, height: 360, bitrate: 800 },
        ];
        return module;
    }

    /** Baseline at t=10s, one tick at t=12s — deterministic 2.0s elapsed.
     *  The tick is awaited directly (not via the interval) so the assertion
     *  can't race the poller's async publish chain. */
    async function runOneTick(module: any) {
        module.throughput.start();
        vi.setSystemTime(new Date(12_000));
        await (module.throughput as any).tick();
        module.throughput.stop();
    }

    it('publishes a PER-RENDITION live bitrate section, not a single sum', async () => {
        const module = setup();
        // Over the first 2s tick: 625 kB → 2.5 Mbps; 200 kB → 0.8 Mbps.
        module.readBusSinkBytes = vi.fn(async (name: string) =>
            name === 'busout_41000' ? 625_000 : 200_000,
        );
        await runOneTick(module);

        expect(module.dynamicStatusSections).toEqual([
            {
                id: 'throughput',
                label: 'Live Throughput',
                fields: [
                    { key: 'r0', label: '1280x720 @ 2500k', unit: 'Mbps' },
                    { key: 'r1', label: '640x360 @ 800k', unit: 'Mbps' },
                    { key: 'total', label: 'Total', unit: 'Mbps' },
                    { key: 'totalBytes', label: 'Total Bytes' },
                ],
            },
        ]);
        expect(module.setStatusData).toHaveBeenCalledWith(
            'throughput',
            expect.objectContaining({ r0: 2.5, r1: 0.8, total: 3.3 }),
        );
        // Face badge stays the aggregate headline.
        expect(module.setBadge).toHaveBeenCalledWith('bitrate', bitrateBadge(3300));
        expect(bitrateBadge(3300)).toEqual({ icon: 'activity', text: '3.3 Mbps', color: '#10b981' });
    });

    it('skips the tick when a sink counter is unavailable (idle / not playing)', async () => {
        const module = setup();
        module.readBusSinkBytes = vi.fn(async (name: string) =>
            name === 'busout_41000' ? 625_000 : undefined,
        );
        await runOneTick(module);
        expect(module.setStatusData).not.toHaveBeenCalledWith('throughput', expect.anything());
        expect(module.setBadge).not.toHaveBeenCalled();
    });
});

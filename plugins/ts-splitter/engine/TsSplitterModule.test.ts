import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TsSplitterModule } from './TsSplitterModule.js';
import { pidPortId } from './splitterPorts.js';

function makeModule(opts: { upstream?: null | { port: number; socketPath?: string } } = {}) {
    const module = new TsSplitterModule();
    const getModuleBusSource = vi.fn(() =>
        opts.upstream === null
            ? undefined
            : {
                  port: opts.upstream?.port ?? 40000,
                  connectionId: 'c-up',
                  sourceModuleId: 'ip-in-1',
                  sourcePortId: 'mpegts-out',
                  socketPath: opts.upstream?.socketPath ?? '/tmp/mr-bus-40000-edge.sock',
              },
    );
    let nextPort = 41000;
    const allocated: Record<string, number> = {};
    const assignBusChannel = vi.fn((modId: string, portId?: string) => {
        const key = portId ? `${modId}:${portId}` : modId;
        if (!(key in allocated)) allocated[key] = nextPort++;
        return { port: allocated[key] };
    });
    (module as any).services = {
        instanceId: 'split-1',
        mediaRouter: { getModuleBusSource, assignBusChannel },
    };
    return { module, getModuleBusSource, assignBusChannel, allocated };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('TsSplitterModule.buildPipeline', () => {
    it('returns null without a router', () => {
        const module = new TsSplitterModule();
        expect(module.buildPipeline({})).toBeNull();
    });

    it('returns null + warning health when no upstream is wired', () => {
        const { module } = makeModule({ upstream: null });
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('upstream'));
    });

    it('zero persisted streams -> input-only pipeline (discovery-first)', () => {
        const { module, assignBusChannel } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain(
            'unixfdsrc name=netin socket-path=/tmp/mr-bus-40000-edge.sock',
        );
        expect(desc!.pipeline).toContain('appsink name=splitin');
        expect(desc!.pipeline).not.toContain('appsrc');
        expect(desc!.tsSplit).toMatchObject({ inputAppsink: 'splitin', outputs: [] });
        expect(desc!.restartOnError).toBe(true);
        expect(assignBusChannel).not.toHaveBeenCalled();
    });

    it('allocates one sticky endpoint per persisted stream and builds every output', () => {
        const { module, assignBusChannel } = makeModule();
        const config = {
            discoveredStreams: [
                { pid: 0x65, streamType: 0x1b, media: 'video', codec: 'h264' },
                { pid: 0xc9, streamType: 0x0f, media: 'audio', codec: 'aac' },
            ],
        };
        const desc = module.buildPipeline(config);
        expect(desc).not.toBeNull();
        expect(assignBusChannel).toHaveBeenCalledWith('split-1', pidPortId(0x65));
        expect(assignBusChannel).toHaveBeenCalledWith('split-1', pidPortId(0xc9));
        expect(desc!.tsSplit!.outputs).toEqual([
            { pid: 0x65, appsrc: 'out_0x65', streamType: 0x1b, port: 41000 },
            { pid: 0xc9, appsrc: 'out_0xc9', streamType: 0x0f, port: 41001 },
        ]);
        expect(desc!.pipeline).toContain('appsrc name=out_0x65');
        expect(desc!.pipeline).toContain('appsrc name=out_0xc9');
    });

    it('port pool exhaustion -> error health + null', () => {
        const { module } = makeModule();
        (module as any).services.mediaRouter.assignBusChannel = vi.fn(() => undefined);
        const setHealth = vi.spyOn(module as any, 'setHealth').mockImplementation(() => undefined);
        const desc = module.buildPipeline({
            discoveredStreams: [{ pid: 0x65, streamType: 0x1b, media: 'video', codec: 'h264' }],
        });
        expect(desc).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('pid-0x65'));
    });
});

describe('TsSplitterModule discovery', () => {
    it('tssplit:discovered persists via emitConfigUpdate and refreshes ports', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [
                { pid: 0x65, streamType: 0x1b },
                { pid: 0xc9, streamType: 0x0f },
            ],
            pcrPid: 0x65,
        });

        expect(emitted).toHaveLength(1);
        const ports = module.getDynamicPorts();
        expect(ports.some((p) => p.id === pidPortId(0x65))).toBe(true);
        expect(ports.some((p) => p.id === pidPortId(0xc9))).toBe(true);
    });

    it('re-delivering identical discovery emits nothing (idempotent)', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        const payload = { streams: [{ pid: 0x65, streamType: 0x1b }], pcrPid: 0x65 };
        (module as any).onPluginEvent('tssplit:discovered', payload);
        (module as any).onPluginEvent('tssplit:discovered', payload);
        expect(emitted).toHaveLength(1);
    });

    it('layers the ISO 639 language from esInfo into port labels and status', () => {
        const { module } = makeModule();
        (module as any).config = {};
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [
                { pid: 0x141, streamType: 0x0f, esInfo: '0a046e6f72007c03518003' },
                { pid: 0x65, streamType: 0x1b, esInfo: '' },
            ],
            pcrPid: 0x65,
        });

        const port = module.getDynamicPorts().find((p) => p.id === pidPortId(0x141))!;
        expect(port.label).toBe('Audio nor (aac, PID 0x141)');
        expect(module.getDynamicPorts().find((p) => p.id === pidPortId(0x65))!.label).toBe(
            'Video (h264, PID 0x65)',
        );
        const section = (module as any).dynamicStatusSections.find(
            (s: { id: string }) => s.id === 'stream-321',
        );
        expect(section.label).toBe('Audio nor (aac, PID 0x141)');
        expect(section.fields.some((f: { key: string }) => f.key === 'language')).toBe(true);
    });

    it('a language appearing on a known PID re-persists (not treated as identical)', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const emitted: unknown[] = [];
        vi.spyOn(module as any, 'emitConfigUpdate').mockImplementation((changes: any) => {
            emitted.push(changes);
            Object.assign((module as any).config, changes);
        });

        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [{ pid: 0x141, streamType: 0x0f }],
            pcrPid: 0x65,
        });
        (module as any).onPluginEvent('tssplit:discovered', {
            streams: [{ pid: 0x141, streamType: 0x0f, esInfo: '0a0464657500' }],
            pcrPid: 0x65,
        });
        expect(emitted).toHaveLength(2);
        expect(module.getDynamicPorts().find((p) => p.id === pidPortId(0x141))!.label).toBe(
            'Audio deu (aac, PID 0x141)',
        );
    });

    it('other channels are ignored', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const spy = vi.spyOn(module as any, 'emitConfigUpdate');
        (module as any).onPluginEvent('rist:stats', { anything: true });
        expect(spy).not.toHaveBeenCalled();
    });
});

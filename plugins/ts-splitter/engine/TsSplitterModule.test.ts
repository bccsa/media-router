import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TsSplitterModule } from './TsSplitterModule.js';
import { pidPortId } from './splitterPorts.js';

function makeModule(opts: { upstream?: null | { port: number; socketPath?: string } } = {}) {
    const module = new TsSplitterModule();
    const getModuleUdpSource = vi.fn(() =>
        opts.upstream === null
            ? undefined
            : {
                  host: '239.255.0.1',
                  port: opts.upstream?.port ?? 40000,
                  connectionId: 'c-up',
                  sourceModuleId: 'ip-in-1',
                  sourcePortId: 'mpegts-out',
                  socketPath: opts.upstream?.socketPath,
              },
    );
    let nextPort = 41000;
    const allocated: Record<string, number> = {};
    const assignUdpPort = vi.fn((modId: string, portId?: string) => {
        const key = portId ? `${modId}:${portId}` : modId;
        if (!(key in allocated)) allocated[key] = nextPort++;
        return { host: '239.255.0.1', port: allocated[key] };
    });
    (module as any).services = {
        instanceId: 'split-1',
        mediaRouter: { getModuleUdpSource, assignUdpPort },
    };
    return { module, getModuleUdpSource, assignUdpPort, allocated };
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
        const { module, assignUdpPort } = makeModule();
        const desc = module.buildPipeline({});
        expect(desc).not.toBeNull();
        expect(desc!.pipeline).toContain('appsink name=splitin');
        expect(desc!.pipeline).not.toContain('appsrc');
        expect(desc!.tsSplit).toMatchObject({ inputAppsink: 'splitin', outputs: [] });
        expect(desc!.restartOnError).toBe(true);
        expect(assignUdpPort).not.toHaveBeenCalled();
    });

    it('allocates one sticky endpoint per persisted stream and builds every output', () => {
        const { module, assignUdpPort } = makeModule();
        const config = {
            discoveredStreams: [
                { pid: 0x65, streamType: 0x1b, media: 'video', codec: 'h264' },
                { pid: 0xc9, streamType: 0x0f, media: 'audio', codec: 'aac' },
            ],
        };
        const desc = module.buildPipeline(config);
        expect(desc).not.toBeNull();
        expect(assignUdpPort).toHaveBeenCalledWith('split-1', pidPortId(0x65));
        expect(assignUdpPort).toHaveBeenCalledWith('split-1', pidPortId(0xc9));
        expect(desc!.tsSplit!.outputs).toEqual([
            { pid: 0x65, appsrc: 'out_0x65', streamType: 0x1b, port: 41000 },
            { pid: 0xc9, appsrc: 'out_0xc9', streamType: 0x0f, port: 41001 },
        ]);
        expect(desc!.pipeline).toContain('appsrc name=out_0x65');
        expect(desc!.pipeline).toContain('appsrc name=out_0xc9');
    });

    it('port pool exhaustion -> error health + null', () => {
        const { module } = makeModule();
        (module as any).services.mediaRouter.assignUdpPort = vi.fn(() => undefined);
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

    it('other channels are ignored', () => {
        const { module } = makeModule();
        (module as any).config = {};
        const spy = vi.spyOn(module as any, 'emitConfigUpdate');
        (module as any).onPluginEvent('rist:stats', { anything: true });
        expect(spy).not.toHaveBeenCalled();
    });
});
